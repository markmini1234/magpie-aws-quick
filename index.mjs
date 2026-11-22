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
const CSRF = /&quot;csrf&quot;:&quot;([^&]+)&quot;|"csrf"\s*:\s*"([^"]+)"/;
const USER_ID = /&quot;quickSightUserId&quot;:&quot;([^&]+)&quot;|"quickSightUserId"\s*:\s*"([^"]+)"/;
const ACCOUNT_ID = /&quot;awsAccountId&quot;:&quot;([^&]+)&quot;|"awsAccountId"\s*:\s*"([^"]+)"/;
const QUOTA = /agent\s*hours?|entitlement|quota|usage\s*limit|insufficient.*(minutes|hours)|(minutes|hours).*(exhausted|exceeded)/i;
const EXPIRED = "The Quick session has expired. Sign in to Quick again and re-add the cookie.";
const PAGE_TTL = 5 * 60 * 1000;

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

// aliasFromServer asks Quick which account the session is for. A signed-in
// session is redirected from /sn/start to /sn/account/<alias>/start; a
// signed-out one to /sn.
async function aliasFromServer(cookieHeader, signal) {
  const response = await fetch(`${ORIGIN}/sn/start`, {
    headers: { cookie: cookieHeader, accept: "text/html" },
    redirect: "manual",
    signal,
  });
  if (response.status !== 302) return { error: `Quick answered HTTP ${response.status} instead of redirecting to an account` };
  const location = response.headers.get("location") ?? "";
  const found = /\/sn\/account\/([^/?#]+)\//.exec(location);
  if (found) return { alias: decodeURIComponent(found[1]) };
  return { expired: true };
}

// sessionFrom is the sign-in boundary: it reads the pasted Cookie once and
// hands typed values inward.
async function sessionFrom(cookie, askedAlias, signal) {
  if (!cookie.has("JSESSIONID")) {
    return {
      error: `No JSESSIONID in what was pasted (found: ${[...cookie.keys()].join(", ") || "nothing"}). Copy the Cookie header of a request to quick.aws.com while signed in.`,
    };
  }
  const header = [...cookie].map(([name, value]) => `${name}=${value}`).join("; ");
  const given = typeof askedAlias === "string" ? askedAlias.trim() : "";
  // The server is the word on whether the session is signed in, and which
  // account it belongs to. The cookie alone is not: a signed-out page also
  // carries a JSESSIONID, and the alias cookies appear only after the
  // account page loads.
  const asked = await aliasFromServer(header, signal);
  if (asked.alias) return { alias: given || asked.alias, cookie: header };
  if (asked.expired) return { error: EXPIRED, expired: true };
  if (given) return { alias: given, cookie: header };
  return { error: asked.error };
}

// pageOf reads what the Quick page hands the app: the CSRF token every call
// carries, and the user's ARN the metering API asks for.
async function pageOf(session, signal) {
  const response = await fetch(`${ORIGIN}/sn/account/${encodeURIComponent(session.alias)}/start/chat`, {
    headers: { cookie: session.cookie, accept: "text/html" },
    redirect: "manual",
    signal,
  });
  // A signed-out session is answered with a redirect to /sn, not a page.
  if (response.status !== 200) return { expired: true };
  const page = await response.text();
  const token = CSRF.exec(page)?.[1] ?? CSRF.exec(page)?.[2];
  if (!token) return { error: "The Quick page carried no CSRF token" };
  const user = USER_ID.exec(page);
  const account = ACCOUNT_ID.exec(page);
  return {
    csrf: decodeURIComponent(token),
    userId: decodeURIComponent(user?.[1] ?? user?.[2] ?? ""),
    accountId: (account?.[1] ?? account?.[2] ?? "") || session.alias,
  };
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

async function quickChat(session, page, body, signal) {
  const model = String(body.model ?? "auto").replace(`${ID}/`, "");
  const mode = MODES[model]?.mode;
  const userMessage = promptOf(Array.isArray(body.messages) ? body.messages : []);
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
    redirect: "manual",
    signal,
  });
  return { model, response };
}

const errorResponse = (status, message, signIn, headers = {}) =>
  new Response(JSON.stringify({ error: { type: status === 401 ? "authentication_error" : "api_error", message } }), {
    status,
    headers: { "content-type": "application/json", ...(signIn ? { "X-Magpie-Sign-In": signIn } : {}), ...headers },
  });

async function failure(response) {
  // A signed-out session is answered with the login page, not the API.
  if (response.status === 301 || response.status === 302) return errorResponse(401, EXPIRED, "expired");
  const text = (await response.text()).trim().slice(0, 800);
  if (response.status === 401) return errorResponse(401, EXPIRED, "expired");
  // Quick's free trial counts agent hours, and a spent allowance comes back
  // as a request error. 429 sends the request to the group's other providers
  // and rests this account, as a spent allowance should.
  if ((response.status === 400 || response.status === 402 || response.status === 429) && QUOTA.test(text)) {
    return errorResponse(429, text, "", { "retry-after": "600" });
  }
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
        // The page's CSRF token and user ARN are read once and kept for a few
        // minutes. A request that finds the session gone reads it again.
        let page;
        let readAt = 0;
        const pageNow = async (signal) => {
          if (page && Date.now() - readAt < PAGE_TTL) return page;
          page = await pageOf(session, signal);
          readAt = Date.now();
          return page;
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
            const signal = init.signal ?? request?.signal;
            let current = await pageNow(signal);
            if (current.expired) return errorResponse(401, EXPIRED, "expired");
            if (current.error) return errorResponse(502, current.error);
            let result = await quickChat(session, current, body, signal);
            // A CSRF token can be spent by a page the user reloaded; read the
            // page once more and retry that request.
            if (result.response?.status === 401) {
              page = undefined;
              current = await pageNow(signal);
              if (current.expired) return errorResponse(401, EXPIRED, "expired");
              result = await quickChat(session, current, body, signal);
            }
            if (result.expired) return errorResponse(401, EXPIRED, "expired");
            if (result.error) return errorResponse(400, result.error);
            return answer(result.response, result.model, body.stream === true);
          },
        };
      },

      // usage is Quick's own agent-hours allowance: the free trial provisions
      // 600 minutes (10 hours), shown beside the account as a share.
      async usage(getAuth, _provider, options = {}) {
        const auth = await getAuth();
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
          headers: { cookie, "x-amzn-csrf-token": page.csrf, accept: "application/json" },
          signal: options.signal,
        });
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
