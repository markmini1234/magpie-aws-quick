// AWS Quick (quick.aws.com) for Magpie — merged provider.
//
// Two transports, behind one provider:
//
//   1. Desktop agent channel (full agent: memory, tools, Opus 5.5). It speaks
//      the desktop client's own bidi WebSocket over OIDC tokens, the same
//      transport magpie-aws-quick (httpdone) drives. Sign-in replays the
//      desktop app's OIDC+PKCE flow, or reuses the installed app's login.
//   2. Web-console light channel (the original magpie-quick-auth): a Cookie
//      plus the page CSRF token against /conversations/chat. Lighter, but it
//      is the channel that rotates JSESSIONID on every reply — which this
//      plugin keeps by writing rotated cookies back to the auth store.
//
// Sign-in methods (magpie login quick):
//   - 账号登录（浏览器 OAuth，无需桌面端）— OIDC, auto-refresh
//   - 复制登录地址 — same flow for a browser on another machine
//   - 本地凭据（桌面端登录态）— Credential Manager on Windows, else outpost
//   - AWS Quick cookie / browser — the light channel's two sign-ins
//
// Accounts are kept apart: Magpie spreads requests over every Quick account
// signed in, rests one whose session lapsed or whose allowance ran out, and
// asks the next. No single: true, no maxAccounts.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { QUICK_LOGIN, quickSession } from "./src/browser.mjs";
import { applySetCookie, headerOf, jarOf } from "./src/cookies.mjs";
import { decodeEventStream, eventTypeOf, frameMessage } from "./src/eventstream.mjs";
import { createOutpostManager } from "./lib/outpost.mjs";
import { handleChatCompletions } from "./lib/handler.mjs";
import { createSessionStore, SESSION_DEFAULTS } from "./lib/sessions.mjs";
import { createDirectBackend, startOAuthLogin, takeDiscovery, keyForSession, OAuthError, defaultStoreDir, oauthDeviceId, isDeviceId, createSessionStore as createOAuthStore } from "./lib/oauth.mjs";
import { createCredManBackend, loadCredManSession, credManDeviceId } from "./lib/credman.mjs";
import { quickUsage } from "./lib/usage.mjs";

const ID = "quick";
const ORIGIN = "https://quick.aws.com";
const BASE = `${ORIGIN}/magpie-aws-quick/v1`;

const CSRF = /&quot;csrf&quot;:&quot;([^&]+)&quot;|"csrf"\s*:\s*"([^"]+)"/;
const USER_ID = /&quot;quickSightUserId&quot;:&quot;([^&]+)&quot;|"quickSightUserId"\s*:\s*"([^"]+)"/;
const ACCOUNT_ID = /&quot;awsAccountId&quot;:&quot;([^&]+)&quot;|"awsAccountId"\s*:\s*"([^"]+)"/;
const QUOTA = /agent\s*hours?|entitlement|quota|usage\s*limit|insufficient.*(minutes|hours)|(minutes|hours).*(exhausted|exceeded)/i;
const EXPIRED = "The Quick session has expired or was replaced (Quick rotates JSESSIONID on every reply). Sign in to Quick again, or paste a freshly copied cookie.";
const PAGE_TTL = 5 * 60 * 1000;
const MESSAGE_LIMIT = 49_999;
const OMITTED = "[... earlier messages omitted ...]";
const CUT = "\n[... truncated ...]";

const AGENT_MODES = Object.freeze(["fast", "balanced", "smart", "advanced"]);
const LIGHT_MODES = {
  "web-auto": { name: "Web Auto (light)", mode: undefined, reasoning: false },
  "web-fast": { name: "Web Fast (light)", mode: "FAST", reasoning: false },
  "web-smart": { name: "Web Smart (light)", mode: "SMART", reasoning: true },
  "web-advanced": { name: "Web Advanced (light)", mode: "ADVANCED", reasoning: true },
};

const AGENT_MODEL_BASE = {
  limit: { context: 1000000, output: 64000 },
  tool_call: true,
  api: { url: BASE, npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true },
    interleaved: false,
  },
};

const LIGHT_MODEL_BASE = {
  limit: { context: 1000000, output: 128000 },
  tool_call: false,
  api: { url: BASE, npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: false,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true },
    interleaved: false,
  },
};

function modelList() {
  const out = {};
  for (const mode of AGENT_MODES) {
    out[mode] = {
      ...structuredClone(AGENT_MODEL_BASE),
      name: { fast: "Quick Fast", balanced: "Quick Balanced", smart: "Quick Smart", advanced: "Quick Advanced" }[mode],
    };
  }
  for (const [key, m] of Object.entries(LIGHT_MODES)) {
    out[key] = { ...structuredClone(LIGHT_MODEL_BASE), name: m.name, reasoning: m.reasoning };
  }
  return out;
}

// ---------------------------------------------------------------- cookies ----

function cookiePairs(text) {
  const header =
    /(?:^|\s)(?:-H\s+|--header\s+)?['"]cookie:\s*([^'"]+)['"]/im.exec(text)?.[1] ??
    /^\s*cookie:\s*(.+)$/im.exec(text)?.[1] ??
    text;
  const out = new Map();
  for (const part of header.replace(/\s*\n\s*/g, "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    let value = part.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name) out.set(name, value);
  }
  return out;
}

async function aliasFromServer(cookieHeader, signal) {
  const response = await fetch(`${ORIGIN}/sn/start`, {
    headers: { cookie: cookieHeader, accept: "text/html" },
    redirect: "manual",
    signal,
  });
  const cookie = applySetCookie(cookieHeader, response.headers.getSetCookie?.() ?? []);
  if (response.status !== 302) return { error: `Quick answered HTTP ${response.status} instead of redirecting to an account` };
  const location = response.headers.get("location") ?? "";
  const found = /\/sn\/account\/([^/?#]+)\//.exec(location);
  if (found) return { alias: decodeURIComponent(found[1]), cookie };
  return { expired: true };
}

async function sessionFrom(cookie, askedAlias, signal) {
  if (!cookie.has("JSESSIONID")) {
    return {
      error: `No JSESSIONID in what was pasted (found: ${[...cookie.keys()].join(", ") || "nothing"}). Copy the Cookie header of a request to quick.aws.com while signed in.`,
    };
  }
  const header = headerOf(cookie);
  const given = typeof askedAlias === "string" ? askedAlias.trim() : "";
  const asked = await aliasFromServer(header, signal);
  if (asked.alias) return { alias: given || asked.alias, cookie: asked.cookie };
  if (asked.expired) return { error: EXPIRED, expired: true };
  if (given) return { alias: given, cookie: asked.cookie };
  return { error: asked.error };
}

async function pageOf(session, signal) {
  const response = await fetch(`${ORIGIN}/sn/account/${encodeURIComponent(session.alias)}/start/chat`, {
    headers: { cookie: session.cookie, accept: "text/html" },
    redirect: "manual",
    signal,
  });
  const cookie = applySetCookie(session.cookie, response.headers.getSetCookie?.() ?? []);
  if (response.status !== 200) return { expired: true };
  const page = await response.text();
  const token = CSRF.exec(page)?.[1] ?? CSRF.exec(page)?.[2];
  if (!token) return { error: "The Quick page carried no CSRF token" };
  const user = USER_ID.exec(page);
  const account = ACCOUNT_ID.exec(page);
  return {
    cookie,
    csrf: decodeURIComponent(token),
    userId: decodeURIComponent(user?.[1] ?? user?.[2] ?? ""),
    accountId: (account?.[1] ?? account?.[2] ?? "") || session.alias,
  };
}

// ------------------------------------------------------------ light chat ----

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || part.type === "input_text"))
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function linesOf(messages) {
  const instructions = [];
  const turns = [];
  for (const message of messages) {
    const text = textOf(message?.content);
    if (!text) continue;
    if (message.role === "system" || message.role === "developer") instructions.push(`System instructions:\n${text}`);
    else if (message.role === "assistant") turns.push(`Assistant: ${text}`);
    else if (message.role === "tool") turns.push(`Tool result: ${text}`);
    else turns.push(`User: ${text}`);
  }
  return { instructions, turns };
}

function clip(text, budget) {
  if (budget <= 0) return "";
  if (text.length <= budget) return text;
  if (budget <= CUT.length) return text.slice(0, budget);
  const room = budget - CUT.length;
  const head = Math.ceil(room * 0.4);
  return text.slice(0, head) + CUT + text.slice(text.length - (room - head));
}

function promptOf(messages) {
  const { instructions, turns } = linesOf(messages);
  if (turns.length === 1 && instructions.length === 0 && turns[0].startsWith("User: ")) {
    return clip(turns[0].slice(6), MESSAGE_LIMIT);
  }
  if (!turns.length) return clip(instructions.join("\n\n"), MESSAGE_LIMIT);
  const fixed = clip(instructions.join("\n\n"), Math.floor(MESSAGE_LIMIT * 0.3));
  const prefix = fixed ? `${fixed}\n\n` : "";
  const room = MESSAGE_LIMIT - prefix.length - OMITTED.length - 2;
  const newest = turns.at(-1);
  const kept = [clip(newest, Math.max(room, 0))];
  let used = kept[0].length;
  for (let i = turns.length - 2; i >= 0; i--) {
    const cost = turns[i].length + 2;
    if (used + cost > room) break;
    kept.unshift(turns[i]);
    used += cost;
  }
  const body = kept.length < turns.length ? [OMITTED, ...kept].join("\n\n") : kept.join("\n\n");
  return (prefix + body).slice(0, MESSAGE_LIMIT);
}

function openAIBody(model, text, created) {
  return {
    id: `chatcmpl-quick-${randomUUID()}`,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function chunkOf(id, model, created, delta, finish = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;

async function lightChat(session, page, body, signal, continued) {
  const model = String(body.model ?? "web-auto").replace(`${ID}/`, "");
  const mode = LIGHT_MODES[model]?.mode;
  const turns = Array.isArray(body.messages) ? body.messages : [];
  const latest = continued ? textOf(turns.at(-1)?.content) : "";
  const continues = continued && latest.length <= MESSAGE_LIMIT ? continued : undefined;
  const userMessage = continues ? latest : promptOf(turns);
  if (!userMessage) return { error: "Quick needs at least one non-empty text message" };
  const found = page;
  const url = new URL(
    `${ORIGIN}/sn/account/${encodeURIComponent(session.alias)}/qbsproxy/quicksight/accounts/${encodeURIComponent(found.accountId)}/conversations/chat`,
  );
  url.searchParams.set("mbtc", found.csrf);
  const payload = {
    userMessage,
    clientToken: randomUUID(),
    inferenceOnly: true,
    temporaryChat: !continues,
    ...(continues ? { conversationId: continues } : {}),
    ...(mode ? { performanceMode: mode } : {}),
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      accept: "*/*",
      "x-amzn-csrf-token": found.csrf,
      "x-amzn-target": "api",
      origin: ORIGIN,
      referer: `${ORIGIN}/sn/account/${encodeURIComponent(session.alias)}/start/chat`,
    },
    body: JSON.stringify(payload),
    redirect: "manual",
    signal,
  });
  const cookie = applySetCookie(session.cookie, response.headers.getSetCookie?.() ?? []);
  return { model, response, cookie };
}

const errorResponse = (status, message, signIn, headers = {}) =>
  new Response(JSON.stringify({ error: { type: status === 401 ? "authentication_error" : "api_error", message } }), {
    status,
    headers: { "content-type": "application/json", ...(signIn ? { "X-Magpie-Sign-In": signIn } : {}), ...headers },
  });

async function failure(response) {
  if (response.status === 301 || response.status === 302) return errorResponse(401, EXPIRED, "expired");
  const text = (await response.text()).trim().slice(0, 800);
  if (response.status === 401) return errorResponse(401, EXPIRED, "expired");
  if ((response.status === 400 || response.status === 402 || response.status === 429) && QUOTA.test(text)) {
    return errorResponse(429, text, "", { "retry-after": "600" });
  }
  return errorResponse(response.status, text || `Quick answered HTTP ${response.status}`);
}

async function answer(response, model, stream, happened = () => {}) {
  if (!response.ok) return failure(response);
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-quick-${randomUUID()}`;
  const encoder = new TextEncoder();
  let conversation = "";
  if (!stream) {
    let text = "";
    for await (const frame of decodeEventStream(response.body)) {
      const type = eventTypeOf(frame);
      if (frame.payload?.conversationId) conversation = String(frame.payload.conversationId);
      if (type === "textMessageEvent") text += String(frame.payload?.textMessage ?? "");
      else if (type === "metadataEvent" && !text) text = String(frame.payload?.finalTextMessage ?? "");
      else if (type === "internalFailureException" || type === "invalidRequestException") throw new Error(frameMessage(frame));
    }
    happened(conversation, text);
    return new Response(JSON.stringify(openAIBody(model, text, created)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const body = new ReadableStream({
    async start(controller) {
      let sent = false;
      let text = "";
      controller.enqueue(encoder.encode(sse(chunkOf(id, model, created, { role: "assistant", content: "" }))));
      for await (const frame of decodeEventStream(response.body)) {
        const type = eventTypeOf(frame);
        if (frame.payload?.conversationId) conversation = String(frame.payload.conversationId);
        if (type === "textMessageEvent") {
          const part = String(frame.payload?.textMessage ?? "");
          if (part) {
            sent = true;
            text += part;
            controller.enqueue(encoder.encode(sse(chunkOf(id, model, created, { content: part }))));
          }
        } else if (type === "metadataEvent" && frame.payload?.finalTextMessage && !sent) {
          sent = true;
          text = String(frame.payload.finalTextMessage);
          controller.enqueue(encoder.encode(sse(chunkOf(id, model, created, { content: text }))));
        } else if (type === "internalFailureException" || type === "invalidRequestException") {
          throw new Error(frameMessage(frame));
        }
      }
      happened(conversation, text);
      controller.enqueue(encoder.encode(sse(chunkOf(id, model, created, {}, "stop"))));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// ---------------------------------------------------------------- plugin ----

function requestUrl(input) {
  try {
    return input instanceof Request ? new URL(input.url) : new URL(String(input));
  } catch {
    return null;
  }
}

async function readBody(input, init) {
  let raw = init?.body;
  if (raw == null && input instanceof Request) raw = await input.text();
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
  if (typeof raw !== "string") raw = raw == null ? "" : String(raw);
  return JSON.parse(raw || "{}");
}

function headerOfInput(input, init, name) {
  try {
    const own = init?.headers ? new Headers(init.headers).get(name) : null;
    return own ?? (input instanceof Request ? input.headers.get(name) : null) ?? undefined;
  } catch {
    return undefined;
  }
}

async function identityFor(outpost, fallback) {
  try {
    const s = await outpost.session();
    const who = [s?.provider, s?.aws_account_id, s?.actor_arn, s?.tenant_url].filter(Boolean).join(":");
    if (who) return `${fallback}|${who}`;
  } catch {}
  return fallback;
}

function makeAgentFetch(outpostMgr, opts, sessions) {
  return async function agentFetch(input, init) {
    const url = requestUrl(input);
    const path = url?.pathname ?? "";
    if (!/\/chat\/completions\/?$/.test(path)) {
      return new Response(JSON.stringify({ error: { message: `quick agent only serves chat/completions (got ${path})`, type: "invalid_request_error" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    let body;
    try {
      body = await readBody(input, init);
    } catch {
      return new Response(JSON.stringify({ error: { message: "request body must be JSON", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const outpost = await outpostMgr.ensure().catch((e) => ({ __err: e }));
    if (outpost?.__err) {
      const e = outpost.__err;
      return new Response(JSON.stringify({ error: { message: e?.message ?? String(e), type: "api_error", code: 503 } }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const identity = await identityFor(outpost, opts.identityKey || "quick");
    const sessionKey = ["x-magpie-session", "session_id", "x-session-id", "x-session-affinity", "x-client-request-id", "x-thread-id", "x-conversation-id"]
      .map((n) => headerOfInput(input, init, n))
      .find((v) => typeof v === "string" && v.trim());
    return handleChatCompletions({
      body,
      outpostMgr,
      sessions,
      options: { ...opts, identity, sessionKey },
      effortHeader: headerOfInput(input, init, "x-magpie-effort"),
      signal: init?.signal,
    });
  };
}

function makeSessions(opts) {
  if (opts.sessionReuse === false || opts.sessionReuse === "false" || opts.sessionReuse === 0) return undefined;
  const ttlMs = Number(opts.sessionTtlMs) > 0 ? Number(opts.sessionTtlMs) : SESSION_DEFAULTS.ttlMs;
  const max = Number(opts.sessionMax) > 0 ? Math.floor(Number(opts.sessionMax)) : SESSION_DEFAULTS.max;
  const dir = opts.sessionDir || defaultStoreDir();
  return createSessionStore({ ttlMs, max, file: path.join(dir, "thread-sessions.json") });
}

export async function QuickPlugin(input = {}, _options = {}) {
  const opts = (input?.options && typeof input.options === "object" ? input.options : {}) || {};
  const outpostMgr = createOutpostManager(opts);
  const sessions = makeSessions(opts);
  const stableDeviceId = opts.stableDeviceId !== false;

  function backendFor(auth) {
    const key = auth?.type === "api" ? auth.key : auth?.type === "oauth" ? auth.access : undefined;
    if (!key) return null;
    // Cookie accounts have no desktop backend: they stay on the light channel.
    if (auth?.metadata?.mode === "cookie") return null;
    if (auth?.metadata?.mode === "oauth") {
      const store = createOAuthStore({ dir: opts.sessionDir });
      const backend = createDirectBackend({
        load: () => store.get(key),
        persist: (s) => store.set(key, s),
        deviceId: stableDeviceId ? oauthDeviceId(store, key) : undefined,
        fetchImpl: opts.fetchImpl,
        log: opts.log,
      });
      return { key, apiKey: "quick-oauth", mgr: { ensure: () => backend.ensure() } };
    }
    if (auth?.metadata?.mode === "local-credman") {
      const backend = createCredManBackend({
        fetchImpl: opts.fetchImpl,
        log: opts.log,
        deviceId: stableDeviceId ? credManDeviceId({ dir: opts.sessionDir || undefined }) : undefined,
      });
      return { key, apiKey: "quick-local", mgr: { ensure: () => backend.ensure() } };
    }
    // No mode at all: treat as a desktop/outpost account only when the key is
    // the sentinel the local-credman method uses; anything else with an alias
    // is a Cookie account (backward compat with pre-merge sign-ins).
    if (auth?.metadata?.alias && key !== "quick-local") return null;
    return { key, apiKey: "quick-local", mgr: outpostMgr };
  }

  function saveOAuthSession(sess) {
    const store = createOAuthStore({ dir: opts.sessionDir });
    const key = keyForSession(sess);
    const prev = store.get(key)?.device_id;
    store.set(key, { ...sess, device_id: isDeviceId(prev) ? prev : sess.device_id || randomUUID() });
    const who = sess.email || sess.display_name || sess.aws_account_id || "";
    return { type: "success", key, metadata: { mode: "oauth", account: who, email: who } };
  }

  const startOAuthOpts = (signal, extra = {}) => ({
    stage: opts.buildStage || "prod",
    port: Number(opts.oauthPort) || undefined,
    timeoutMs: Number(opts.oauthTimeoutMs) || undefined,
    signal,
    fetchImpl: opts.fetchImpl,
    log: opts.log,
    ...extra,
  });

  const wireAbort = (s, cancel) => {
    const onAbort = () => cancel();
    if (s) {
      if (s.aborted) onAbort();
      else s.addEventListener("abort", onAbort, { once: true });
    }
    return () => s?.removeEventListener("abort", onAbort);
  };

  function oauthSignIn({ label, labels, instructions }) {
    return {
      type: "oauth",
      label,
      labels,
      authorize: async (_inputs, { signal } = {}) => {
        let started;
        try {
          started = await startOAuthLogin(startOAuthOpts(signal));
        } catch (e) {
          return { type: "failed", error: `Amazon Quick 账号登录失败：${String(e?.message ?? e).slice(0, 300)}` };
        }
        const { url, done, cancel } = started;
        return {
          url,
          method: "auto",
          instructions,
          callback: async (_code, { signal: s } = {}) => {
            const unwire = wireAbort(s, cancel);
            try {
              const sess = await done;
              return saveOAuthSession(sess);
            } catch (e) {
              const msg = String(e?.message ?? e);
              if (e instanceof OAuthError && e.kind === "abort") return { type: "failed", error: "登录已取消" };
              return { type: "failed", error: `Amazon Quick 账号登录失败：${msg.slice(0, 300)}` };
            } finally {
              unwire();
            }
          },
        };
      },
    };
  }

  function oauthPasteSignIn() {
    return {
      type: "oauth",
      label: "复制登录地址（不自动打开浏览器）",
      labels: { zh: "复制登录地址（不自动打开浏览器）", "zh-TW": "複製登錄地址（不自動打開瀏覽器）", en: "Copy sign-in link (don't open a browser)" },
      authorize: async (_inputs, { signal } = {}) => {
        const dir = opts.sessionDir ?? defaultStoreDir();
        const discovery = takeDiscovery(dir);
        let started;
        try {
          started = await startOAuthLogin(startOAuthOpts(signal, { discovery, dir }));
        } catch (e) {
          return { type: "failed", error: `Amazon Quick 账号登录失败：${String(e?.message ?? e).slice(0, 300)}` };
        }
        const { url, submit, cancel } = started;
        return {
          url,
          method: "code",
          opened: true,
          instructions: discovery
            ? "已记住上次的账号信息。复制下方链接到浏览器里登录，完成后把地址栏里的完整地址粘贴到下面。"
            : "复制下方链接，到你要用的浏览器里打开并登录。登录完把浏览器地址栏里的完整地址粘贴到下面（页面打不开也没关系，复制地址就行）。",
          callback: async (code, { signal: s } = {}) => {
            const unwire = wireAbort(s, cancel);
            try {
              const sess = await submit(code);
              return saveOAuthSession(sess);
            } catch (e) {
              const msg = String(e?.message ?? e);
              if (e instanceof OAuthError && e.kind === "discovery-saved") {
                return { type: "failed", error: "账号信息已记下。请再点一次「复制登录地址」，登录后把地址栏的地址粘贴回来（15 分钟内有效）。" };
              }
              if (e instanceof OAuthError && e.kind === "paste") return { type: "failed", error: msg };
              if (e instanceof OAuthError && e.kind === "abort") return { type: "failed", error: "登录已取消" };
              return { type: "failed", error: `Amazon Quick 账号登录失败：${msg.slice(0, 300)}` };
            } finally {
              unwire();
              cancel();
            }
          },
        };
      },
    };
  }

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[ID] ??= {
        name: "AWS Quick",
        npm: "@ai-sdk/openai-compatible",
        api: BASE,
        models: modelList(),
      };
      cfg.provider[ID].models ??= modelList();
    },

    provider: {
      id: ID,
      models() {
        return modelList();
      },
    },

    auth: {
      provider: ID,
      maxConcurrency: 2,
      methods: [
        oauthSignIn({
          label: "账号登录（浏览器 OAuth，无需桌面端）",
          labels: { zh: "账号登录（浏览器 OAuth，无需桌面端）", "zh-TW": "帳號登錄（瀏覽器 OAuth，無需桌面端）", en: "Browser sign-in (OAuth, no desktop app)" },
          instructions: "在打开的页面完成 Amazon 登录；如果打开的不是你要用的浏览器，复制下面的链接到那个浏览器里打开。登录需在本机完成。",
        }),
        oauthPasteSignIn(),
        {
          type: "api",
          keyless: true,
          label: "本地凭据（Amazon Quick 桌面端登录态）",
          labels: { zh: "本地凭据（Amazon Quick 桌面端登录态）", "zh-TW": "本機憑據（Amazon Quick 桌面端登錄態）" },
          authorize: async (_inputs, { signal } = {}) => {
            if (process.platform === "win32") {
              try {
                const sess = await loadCredManSession();
                if (sess?.jwt) {
                  const backend = createCredManBackend({ fetchImpl: opts.fetchImpl, log: opts.log });
                  await backend.session();
                  const who = sess.email || sess.display_name || sess.aws_account_id || "";
                  return { type: "success", key: "quick-local", metadata: { mode: "local-credman", account: who, email: who } };
                }
              } catch {}
            }
            try {
              const outpost = await outpostMgr.ensure();
              const st = await outpost.status();
              if (!st?.logged_in && !st?.user) {
                return { type: "failed", error: "Amazon Quick 桌面端未登录：请先打开 Amazon Quick 登录，再重试" };
              }
              await outpost.session({ fresh: true });
              return { type: "success", key: "quick-local", metadata: { mode: "local-outpost" } };
            } catch (e) {
              return {
                type: "failed",
                error: `无法连接 Amazon Quick 后端：${String(e?.message ?? e).slice(0, 300)}。请确认已安装并登录 Amazon Quick 桌面版。`,
              };
            }
          },
        },
        {
          type: "oauth",
          label: "AWS Quick cookie (browser)",
          prompts: [
            {
              key: "accountId",
              message: "Quick account alias (blank asks Quick)",
              required: false,
              validate: (value) => (typeof value === "string" && value.trim() && /\s/.test(value.trim()) ? "An account alias has no spaces" : undefined),
            },
          ],
          authorize(inputs, { signal } = {}) {
            return {
              url: QUICK_LOGIN,
              instructions: "Sign in to AWS Quick in the browser window that opens. This window closes by itself when Magpie has the session.",
              opened: true,
              callback: async (_code, options = {}) => {
                const { header } = await quickSession(options.signal ?? signal);
                const session = await sessionFrom(cookiePairs(header), inputs.accountId, options.signal ?? signal);
                if (session.error) return { type: "failed", error: session.error };
                return {
                  type: "success",
                  access: session.cookie,
                  refresh: "",
                  expires: 0,
                  accountId: session.alias,
                  metadata: { mode: "cookie", alias: session.alias, email: session.alias },
                };
              },
            };
          },
        },
        {
          type: "api",
          label: "AWS Quick cookie",
          prompts: [
            {
              key: "cookie",
              message: "Cookie header from a signed-in quick.aws.com request (or the whole cURL)",
              placeholder: "JSESSIONID=...; qs-directory-alias=...",
              validate: (value) => (typeof value === "string" && value.includes("JSESSIONID") ? undefined : "The cookie needs its JSESSIONID"),
            },
            {
              key: "accountId",
              message: "Quick account alias (blank asks Quick)",
              required: false,
            },
          ],
          async authorize(inputs) {
            const session = await sessionFrom(cookiePairs(typeof inputs.cookie === "string" ? inputs.cookie : ""), inputs.accountId);
            if (session.error) return { type: "failed", error: session.error };
            return {
              type: "success",
              key: session.cookie,
              metadata: { mode: "cookie", alias: session.alias, email: session.alias },
            };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        const b = backendFor(auth);
        if (b) {
          return { baseURL: BASE, apiKey: b.apiKey, fetch: makeAgentFetch(b.mgr, { ...opts, identityKey: b.key }, sessions) };
        }
        const cookie = auth?.type === "oauth" ? auth.access : auth?.key;
        const alias = auth?.metadata?.alias;
        if (typeof cookie !== "string" || !cookie) throw new Error("Quick sign-in has no session cookie");
        if (typeof alias !== "string" || !alias) throw new Error("Quick sign-in has no account alias");
        const session = { cookie, alias };
        let stored = auth;
        const keep = async (next) => {
          if (!next || next === session.cookie) return;
          session.cookie = next;
          const set = input?.client?.auth?.set;
          if (typeof set !== "function") return;
          const metadata = { ...(stored?.metadata ?? {}), mode: "cookie", alias, email: stored?.metadata?.email ?? alias };
          const body =
            stored?.type === "oauth"
              ? { type: "oauth", access: next, refresh: stored.refresh ?? "", expires: stored.expires ?? 0, accountId: stored.accountId ?? alias, metadata }
              : { type: "api", key: next, accountId: stored?.accountId ?? alias, metadata };
          stored = body;
          await set({ path: { id: ID }, body });
        };
        let page;
        let readAt = 0;
        const pageNow = async (signal) => {
          if (page && Date.now() - readAt < PAGE_TTL) return page;
          page = await pageOf(session, signal);
          readAt = Date.now();
          if (page.cookie) await keep(page.cookie);
          return page;
        };
        const continuations = new Map();
        const answered = new Map();
        const CONTINUATIONS_MAX = 256;
        const fingerprint = (messages) => createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 32);
        const remember = (map, key, value) => {
          map.delete(key);
          map.set(key, value);
          if (map.size > CONTINUATIONS_MAX) map.delete(map.keys().next().value);
        };
        return {
          baseURL: ORIGIN,
          fetch: async (input, init = {}) => {
            const request = input instanceof Request ? input : undefined;
            const raw = init.body ?? (request ? await request.text() : undefined);
            let body;
            try {
              body = JSON.parse(typeof raw === "string" ? raw : "");
            } catch {
              return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Expected a JSON chat-completions body" } }), {
                status: 400,
                headers: { "content-type": "application/json" },
              });
            }
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Expected a JSON chat-completions body" } }), {
                status: 400,
                headers: { "content-type": "application/json" },
              });
            }
            const turns = Array.isArray(body.messages) ? body.messages : [];
            const signal = init.signal ?? request?.signal;
            let current = await pageNow(signal);
            if (current.expired) return errorResponse(401, EXPIRED, "expired");
            if (current.error) return errorResponse(502, current.error);
            const prefix = turns.slice(0, -1);
            const prefixKey = prefix.length ? fingerprint(prefix) : "";
            const regenerating = !!answered.get(fingerprint(turns));
            const continuing = !regenerating && turns.at(-1)?.role === "user" && prefixKey ? continuations.get(prefixKey)?.id : undefined;
            let result = await lightChat(session, current, body, signal, continuing);
            if (result.cookie) await keep(result.cookie);
            if (result.response?.status === 401) {
              page = undefined;
              current = await pageNow(signal);
              if (current.expired) return errorResponse(401, EXPIRED, "expired");
              result = await lightChat(session, current, body, signal, continuing);
              if (result.cookie) await keep(result.cookie);
            } else if (continuing && result.response?.status === 400) {
              continuations.delete(prefixKey);
              result = await lightChat(session, current, body, signal, undefined);
              if (result.cookie) await keep(result.cookie);
            }
            if (result.expired) return errorResponse(401, EXPIRED, "expired");
            if (result.error) return errorResponse(400, result.error);
            return answer(result.response, result.model, body.stream === true, (conversation, reply) => {
              if (!conversation) return;
              remember(continuations, fingerprint(turns), { id: conversation, at: Date.now() });
              remember(continuations, fingerprint([...turns, { role: "assistant", content: reply }]), { id: conversation, at: Date.now() });
              remember(answered, fingerprint(turns), true);
              remember(answered, fingerprint([...turns, { role: "assistant", content: reply }]), true);
            });
          },
        };
      },

      async usage(getAuth, _provider, options = {}) {
        const auth = await getAuth();
        const b = backendFor(auth);
        if (b) {
          return quickUsage(async () => (await b.mgr.ensure()).session(), { fetchImpl: opts.fetchImpl, signal: options?.signal });
        }
        const cookie = auth?.type === "oauth" ? auth.access : auth?.key;
        const alias = auth?.metadata?.alias;
        if (typeof cookie !== "string" || !cookie || typeof alias !== "string" || !alias) {
          return { error: "Quick sign-in is incomplete" };
        }
        const session = { cookie, alias };
        const page = await pageOf(session, options.signal);
        if (page.expired) return { error: EXPIRED, signIn: "expired" };
        if (page.error) return { error: page.error };
        if (!page.userId) return { error: "Quick did not name the signed-in user" };
        const url = new URL(
          `${ORIGIN}/sn/account/${encodeURIComponent(alias)}/qbsproxy/quicksight/agenticmetering/v1/get-available-entitlement-units`,
        );
        url.searchParams.set("unitType", "AUTOMATION_AGENT_HOUR_UNIT");
        url.searchParams.set("userArn", page.userId);
        url.searchParams.set("mbtc", page.csrf);
        const response = await fetch(url, {
          headers: { cookie: page.cookie ?? cookie, "x-amzn-csrf-token": page.csrf, accept: "application/json" },
          signal: options.signal,
        });
        const rotated = applySetCookie(page.cookie ?? cookie, response.headers.getSetCookie?.() ?? []);
        if (rotated !== cookie && input?.client?.auth?.set) {
          const body =
            auth?.type === "oauth"
              ? { type: "oauth", access: rotated, refresh: auth.refresh ?? "", expires: auth.expires ?? 0, ...(auth.metadata ? { metadata: auth.metadata } : {}) }
              : { type: "api", key: rotated, ...(auth?.metadata ? { metadata: auth.metadata } : {}) };
          await input.client.auth.set({ path: { id: ID }, body });
        }
        if (!response.ok) return { error: `Quick answered HTTP ${response.status} for its allowance` };
        const body = await response.json();
        const hours = Array.isArray(body?.entitlements) ? body.entitlements[0] : undefined;
        if (!hours) return { error: "Quick returned no agent-hours allowance" };
        const available = Number(hours.numMinsAvailable) || 0;
        const provisioned = Number(hours.numMinsProvisioned) || 0;
        const used = Math.max(0, provisioned - available);
        const trial = body?.subscriptionMetadata?.freeTrialMetadata;
        return {
          plan: typeof body?.subscriptionMetadata?.subscriptionType === "string" ? body.subscriptionMetadata.subscriptionType : "Quick",
          until: Number(trial?.expiryDate) > 0 ? Number(trial.expiryDate) : undefined,
          balance: `${(available / 60).toFixed(2)} h left`,
          windows: [
            {
              name: "Agent hours",
              used: provisioned > 0 ? (used / provisioned) * 100 : null,
              amount: used / 60,
              limit: provisioned / 60,
              unit: "hours",
            },
          ],
        };
      },
    },
  };
}

export default QuickPlugin;
