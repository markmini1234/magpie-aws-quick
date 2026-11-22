// AWS Quick (quick.aws.com) for Magpie.
//
// Quick's web console does not call quicksight.<region>.amazonaws.com. It
// calls its own proxy on quick.aws.com:
//
//   POST https://quick.aws.com/sn/account/<alias>/qbsproxy/quicksight/accounts/<id>/conversations/chat
//
// with the browser's Quick session Cookie and the page's CSRF token (mbtc).
// The reply is an AWS event stream whose events are JSON. So the sign-in is
// the Quick session itself, not AWS SigV4 credentials.
import { randomUUID } from "node:crypto";
import { QUICK_LOGIN, quickSession } from "./src/browser.mjs";
import { decodeEventStream, eventTypeOf, frameMessage } from "./src/eventstream.mjs";

const ID = "quick";
const ORIGIN = "https://quick.aws.com";
const ACCOUNT = /^\d{12}$/;
const CSRF = /&quot;csrf&quot;:&quot;([^&]+)&quot;|"csrf"\s*:\s*"([^"]+)"/;

const MODES = {
  auto: { name: "Auto", mode: undefined, reasoning: false },
  fast: { name: "Fast", mode: "FAST", reasoning: false },
  smart: { name: "Smart", mode: "SMART", reasoning: true },
  advanced: { name: "Advanced", mode: "ADVANCED", reasoning: true },
};

const modelConfig = (m) => ({
  name: m.name,
  limit: { context: 1_000_000, output: 128_000 },
  reasoning: m.reasoning,
  tool_call: false,
  attachment: false,
  modalities: { input: ["text"], output: ["text"] },
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
});

function modelList() {
  return Object.fromEntries(Object.entries(MODES).map(([key, mode]) => [key, modelConfig(mode)]));
}

// cookiePairs reads a Cookie header, or the Cookie header of a copied cURL
// command. Newlines inside a value are only wrapping; no cookie value means
// anything by them.
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

function jsonCookie(cookie, name) {
  const raw = cookie.get(name);
  if (!raw) return undefined;
  for (const text of [raw, (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return "";
    }
  })()]) {
    try {
      return JSON.parse(text);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

// aliasOf is the Quick account alias the proxy path is keyed by. It is the
// AWS account id for a standalone account, and a different name for an
// organization's.
function aliasOf(cookie, asked) {
  const given = typeof asked === "string" ? asked.trim() : "";
  if (given) return given;
  const saved = jsonCookie(cookie, "qs-saved-accounts");
  const first = Array.isArray(saved?.a) ? saved.a[0] : undefined;
  const alias = cookie.get("qs-directory-alias") ?? first?.an ?? first?.id;
  if (typeof alias === "string" && alias.trim()) return alias.trim();
  const directory = jsonCookie(cookie, "aws-directoryUserInfo");
  if (typeof directory?.alias === "string" && directory.alias.trim()) return directory.alias.trim();
  return "";
}

// sessionFrom is the sign-in boundary: it reads the pasted Cookie once and
// hands typed values inward.
function sessionFrom(cookie, askedAlias) {
  if (!cookie.has("JSESSIONID")) {
    return {
      error: `No JSESSIONID in what was pasted (found: ${[...cookie.keys()].join(", ") || "nothing"}). Copy the Cookie header of a request to quick.aws.com while signed in.`,
    };
  }
  const alias = aliasOf(cookie, askedAlias);
  if (!alias) {
    return { error: "Could not read the Quick account alias. Paste qs-directory-alias too, or type the account id." };
  }
  return { alias, cookie: [...cookie].map(([name, value]) => `${name}=${value}`).join("; ") };
}

// csrfOf reads the token the page hands the app. It is also in the mbtc
// query parameter of every call the page makes.
async function csrfOf(session, signal) {
  const response = await fetch(`${ORIGIN}/sn/account/${encodeURIComponent(session.alias)}/start/chat`, {
    headers: { cookie: session.cookie, accept: "text/html" },
    redirect: "manual",
    signal,
  });
  // A signed-out session is answered with a redirect to /sn, not a page.
  if (response.status !== 200) return { expired: true };
  const page = await response.text();
  const found = CSRF.exec(page);
  const token = found?.[1] ?? found?.[2];
  if (!token) return { error: "The Quick page carried no CSRF token" };
  return { csrf: decodeURIComponent(token) };
}

// textOf is one OpenAI content value as plain text.
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || part.type === "input_text"))
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

// promptOf is the chat transcript Quick receives as its userMessage.
function promptOf(messages) {
  const said = [];
  for (const message of messages) {
    const text = textOf(message?.content);
    if (!text) continue;
    if (message.role === "system" || message.role === "developer") said.push(`System instructions:\n${text}`);
    else if (message.role === "assistant") said.push(`Assistant: ${text}`);
    else if (message.role === "tool") said.push(`Tool result: ${text}`);
    else said.push(`User: ${text}`);
  }
  if (said.length === 1 && said[0].startsWith("User: ")) return said[0].slice(6);
  return said.join("\n\n");
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

async function quickChat(session, body, signal) {
  const model = String(body.model ?? "auto").replace(`${ID}/`, "");
  const mode = MODES[model]?.mode;
  const userMessage = promptOf(Array.isArray(body.messages) ? body.messages : []);
  if (!userMessage) return { error: "Quick needs at least one non-empty text message" };

  const found = await csrfOf(session, signal);
  if (found.expired) return { expired: true };
  if (found.error) return { error: found.error };
  const url = new URL(
    `${ORIGIN}/sn/account/${encodeURIComponent(session.alias)}/qbsproxy/quicksight/accounts/${encodeURIComponent(session.alias)}/conversations/chat`,
  );
  url.searchParams.set("mbtc", found.csrf);
  const payload = {
    userMessage,
    clientToken: randomUUID(),
    inferenceOnly: true,
    temporaryChat: true,
    ...(mode ? { performanceMode: mode } : {}),
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      accept: "*/*",
      "x-amzn-csrf-token": found.csrf,
      origin: ORIGIN,
      referer: `${ORIGIN}/sn/account/${encodeURIComponent(session.alias)}/start/chat`,
    },
    body: JSON.stringify(payload),
    signal,
  });
  return { model, response };
}

const errorResponse = (status, message, signIn) =>
  new Response(JSON.stringify({ error: { type: status === 401 ? "authentication_error" : "api_error", message } }), {
    status,
    headers: { "content-type": "application/json", ...(signIn ? { "X-Magpie-Sign-In": signIn } : {}) },
  });

const EXPIRED = "The Quick session has expired. Sign in to Quick again and re-add the cookie.";

async function failure(response) {
  const text = (await response.text()).trim().slice(0, 800);
  if (response.status === 401 || response.status === 302) return errorResponse(401, EXPIRED, "expired");
  return errorResponse(response.status, text || `Quick answered HTTP ${response.status}`);
}

// answer turns Quick's event stream into an OpenAI completion.
async function answer(response, model, stream) {
  if (!response.ok) return failure(response);
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-quick-${randomUUID()}`;
  const encoder = new TextEncoder();

  if (!stream) {
    let text = "";
    for await (const frame of decodeEventStream(response.body)) {
      const type = eventTypeOf(frame);
      if (type === "textMessageEvent") text += String(frame.payload?.textMessage ?? "");
      else if (type === "metadataEvent" && !text) text = String(frame.payload?.finalTextMessage ?? "");
      else if (type === "internalFailureException" || type === "invalidRequestException") throw new Error(frameMessage(frame));
    }
    return new Response(JSON.stringify(openAIBody(model, text, created)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const body = new ReadableStream({
    async start(controller) {
      let sent = false;
      controller.enqueue(encoder.encode(sse(chunkOf(id, model, created, { role: "assistant", content: "" }))));
      for await (const frame of decodeEventStream(response.body)) {
        const type = eventTypeOf(frame);
        if (type === "textMessageEvent") {
          const text = String(frame.payload?.textMessage ?? "");
          if (text) {
            sent = true;
            controller.enqueue(encoder.encode(sse(chunkOf(id, model, created, { content: text }))));
          }
        } else if (type === "metadataEvent" && frame.payload?.finalTextMessage && !sent) {
          // A reply that only carries the final text still arrives whole.
          sent = true;
          controller.enqueue(encoder.encode(sse(chunkOf(id, model, created, { content: String(frame.payload.finalTextMessage) }))));
        } else if (type === "internalFailureException" || type === "invalidRequestException") {
          throw new Error(frameMessage(frame));
        }
      }
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

export async function QuickPlugin(_input, _options = {}) {
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[ID] ??= {
        name: "AWS Quick",
        npm: "@ai-sdk/openai-compatible",
        api: ORIGIN,
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
      single: true,
      maxConcurrency: 2,
      methods: [
        {
          type: "oauth",
          label: "AWS Quick (browser)",
          prompts: [
            {
              key: "accountId",
              message: "Quick account alias (blank reads it from the browser session)",
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
                const session = sessionFrom(cookiePairs(header), inputs.accountId);
                if (session.error) return { type: "failed", error: session.error };
                return {
                  type: "success",
                  access: session.cookie,
                  refresh: "",
                  expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
                  metadata: { alias: session.alias },
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
              message: "Quick account alias (blank reads it from the cookie)",
              required: false,
            },
          ],
          authorize(inputs) {
            const session = sessionFrom(cookiePairs(typeof inputs.cookie === "string" ? inputs.cookie : ""), inputs.accountId);
            if (session.error) return { type: "failed", error: session.error };
            return {
              type: "success",
              key: session.cookie,
              metadata: { alias: session.alias },
            };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        const cookie = auth?.type === "oauth" ? auth.access : auth?.key;
        const alias = auth?.metadata?.alias;
        if (typeof cookie !== "string" || !cookie) throw new Error("Quick sign-in has no session cookie");
        if (typeof alias !== "string" || !alias) throw new Error("Quick sign-in has no account alias");
        const session = { cookie, alias };
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
            const result = await quickChat(session, body, init.signal ?? request?.signal);
            if (result.expired) return errorResponse(401, EXPIRED, "expired");
            if (result.error) return errorResponse(400, result.error);
            return answer(result.response, result.model, body.stream === true);
          },
        };
      },
    },
  };
}

export default QuickPlugin;
