// AWS Quick (quick.aws.com) for Magpie.
//
// Quick's web console chats through SpaceNeedleConversationService:
//   POST https://quicksight.<region>.amazonaws.com/accounts/<account>/conversations/chat
// with SigV4 (service "quicksight") and an application/vnd.amazon.eventstream
// reply. The Quick web session keeps temporary AWS credentials in its
// `aws-creds` cookie, so the plugin signs with those and never needs a
// Quick API key.
import { randomUUID } from "node:crypto";
import { QUICK_LOGIN, quickSession } from "./src/browser.mjs";
import { decodeEventStream, eventTypeOf, frameMessage } from "./src/eventstream.mjs";
import { signRequest } from "./src/sigv4.mjs";

const ID = "quick";
const DEFAULT_REGION = "us-east-1";
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const ACCOUNT = /^\d{12}$/;
const MODE = {
  fast: "FAST",
  smart: "SMART",
  advanced: "ADVANCED",
};

const MODELS = {
  auto: { name: "Auto", mode: undefined, reasoning: false },
  fast: { name: "Fast", mode: MODE.fast, reasoning: false },
  smart: { name: "Smart", mode: MODE.smart, reasoning: true },
  advanced: { name: "Advanced", mode: MODE.advanced, reasoning: true },
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

function parseJSON(text) {
  if (typeof text !== "string" || !text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// cookiePairs reads a Cookie header, or the Cookie header of a copied cURL
// command. Repeated names are kept once, as a browser would send them.
function cookiePairs(text) {
  const header =
    /(?:^|\s)(?:-H\s+|--header\s+)?['"]cookie:\s*([^'"]+)['"]/im.exec(text)?.[1] ??
    /^\s*cookie:\s*(.+)$/im.exec(text)?.[1] ??
    text;
  // A cookie copied out of a terminal or a wrapped text box arrives with
  // newlines inside long values; no cookie value means anything by them.
  const flat = header.replace(/\s*\n\s*/g, "");
  const out = new Map();
  for (const part of flat.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    let value = part.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name) out.set(name, value);
  }
  return out;
}

function decodedCookie(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function objectFromCookie(value) {
  const decoded = decodedCookie(value);
  const direct = parseJSON(decoded);
  if (direct) return direct;
  return parseJSON(Buffer.from(decoded, "base64").toString("utf8"));
}

function credentialsOf(cookie) {
  const raw = cookie.get("aws-creds");
  if (!raw) return undefined;
  const value = objectFromCookie(raw);
  if (!value || typeof value !== "object") return undefined;
  const accessKeyId = value.accessKeyId ?? value.AccessKeyId ?? value.accessKeyID;
  const secretAccessKey = value.secretAccessKey ?? value.SecretAccessKey;
  const sessionToken = value.sessionToken ?? value.SessionToken;
  if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string") return undefined;
  return {
    accessKeyId,
    secretAccessKey,
    ...(typeof sessionToken === "string" && sessionToken ? { sessionToken } : {}),
  };
}

function expirationOf(cookie) {
  const raw = cookie.get("aws-creds");
  if (!raw) return Date.now() + 60 * 60 * 1000;
  const value = objectFromCookie(raw);
  const stated = value?.expiration ?? value?.Expiration;
  const at = typeof stated === "number" ? stated : Date.parse(String(stated ?? ""));
  return Number.isFinite(at) && at > Date.now() ? at : Date.now() + 60 * 60 * 1000;
}

function accountOf(cookie) {
  for (const name of ["aws-consoleInfo", "aws-userInfo"]) {
    const raw = cookie.get(name);
    if (!raw) continue;
    const info = objectFromCookie(raw);
    const id = info?.accountId ?? info?.accountID ?? info?.account_id;
    if (typeof id === "string" && ACCOUNT.test(id)) return id;
  }
  return "";
}

function regionOf(cookie, given) {
  const asked = typeof given === "string" ? given.trim() : "";
  if (REGION.test(asked)) return asked;
  for (const name of ["aws-region", "aws-region-name"]) {
    const found = cookie.get(name);
    if (found && REGION.test(found)) return found;
  }
  return DEFAULT_REGION;
}

// sessionOf is the sign-in boundary: it reads the pasted cookie once and
// hands the typed values inward.
function sessionFrom(cookie, askedAccount, askedRegion) {
  const creds = credentialsOf(cookie);
  if (!creds) {
    const names = [...cookie.keys()];
    if (!cookie.has("aws-creds")) {
      if (cookie.has("aws-ds-access-token") || cookie.has("aws-directoryUserInfo")) {
        return {
          error: `This is a Quick single sign-on (AWS Identity Center) session, not an AWS credential. It has aws-ds-access-token and aws-directoryUserInfo but no aws-creds, so it cannot sign the QuickSight API. Open the Quick console once (so *.quicksight.aws.amazon.com loads), then copy the Cookie header of a request to *.quicksight.aws.amazon.com — that one carries aws-creds.`,
        };
      }
      return {
        error: `No aws-creds cookie in what was pasted (found: ${names.join(", ") || "nothing"}). Copy the Cookie header of a request to quick.aws.com or *.quicksight.aws.amazon.com after signing in, not a request to another site.`,
      };
    }
    return {
      error: `aws-creds is present but holds no readable accessKeyId/secretAccessKey. It may be an encrypted or truncated value; copy the cookie again in full, straight from the request headers.`,
    };
  }
  const given = typeof askedAccount === "string" ? askedAccount.trim() : "";
  const accountId = given || accountOf(cookie);
  if (!ACCOUNT.test(accountId)) {
    return {
      error: `AWS account id must be 12 digits, and aws-consoleInfo did not give one (found: ${[...cookie.keys()].join(", ") || "nothing"}). Type it in the account id field.`,
    };
  }
  return { creds, accountId, region: regionOf(cookie, askedRegion), expires: expirationOf(cookie) };
}

function sessionOf(inputs) {
  const text = typeof inputs.cookie === "string" ? inputs.cookie.trim() : "";
  if (!text) return { error: "Paste the Cookie header from a signed-in quick.aws.com request." };
  return sessionFrom(cookiePairs(text), inputs.accountId, inputs.region);
}

// textOf is one OpenAI/Anthropic content value as plain text.
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
    if (message.role === "system" || message.role === "developer") {
      said.push(`System instructions:\n${text}`);
    } else if (message.role === "assistant") {
      said.push(`Assistant: ${text}`);
    } else if (message.role === "tool") {
      said.push(`Tool result: ${text}`);
    } else {
      said.push(`User: ${text}`);
    }
  }
  if (said.length === 1 && said[0].startsWith("User: ")) return said[0].slice(6);
  return said.join("\n\n");
}

function openAIBody(model, text, created = Math.floor(Date.now() / 1000)) {
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

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// quickChat sends one model prompt to Quick's conversation service.
async function quickChat({ creds, accountId, region }, body, signal) {
  const model = String(body.model ?? "auto").replace(`${ID}/`, "");
  const mode = MODELS[model]?.mode;
  const userMessage = promptOf(Array.isArray(body.messages) ? body.messages : []);
  if (!userMessage) throw new Error("Quick needs at least one non-empty text message");
  const url = new URL(`https://quicksight.${region}.amazonaws.com/accounts/${accountId}/conversations/chat`);
  const payload = {
    userMessage,
    clientToken: randomUUID(),
    inferenceOnly: true,
    temporaryChat: true,
    ...(mode ? { performanceMode: mode } : {}),
  };
  const headers = signRequest(
    {
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        accept: "application/vnd.amazon.eventstream",
        "user-agent": "quick/magpie",
      },
      body: JSON.stringify(payload),
    },
    creds,
    { region, service: "quicksight" },
  );
  return { model, response: await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal, redirect: "error" }) };
}

async function failure(response) {
  const text = await response.text();
  const detail = text.trim().slice(0, 800);
  if (response.status === 403 && /ExpiredToken|security token included in the request is expired/i.test(text)) {
    return new Response(JSON.stringify({ error: { type: "authentication_error", message: "The Quick session's AWS credentials expired. Sign in to Quick again and re-add the cookie." } }), {
      status: 401,
      headers: { "content-type": "application/json", "X-Magpie-Sign-In": "expired" },
    });
  }
  return new Response(JSON.stringify({ error: { type: "api_error", message: detail || `Quick answered HTTP ${response.status}` } }), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

// answer reads Quick's event stream once, as either an SSE chat completion or
// a whole JSON completion.
async function answer(response, model, stream) {
  if (!response.ok) return failure(response);
  const type = response.headers.get("content-type") ?? "";
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-quick-${randomUUID()}`;
  const encoder = new TextEncoder();

  if (!stream) {
    let text = "";
    for await (const frame of decodeEventStream(response.body)) {
      const eventType = eventTypeOf(frame);
      if (eventType === "textMessageEvent") text += String(frame.payload?.textMessage ?? "");
      else if (eventType === "metadataEvent" && !text) text = String(frame.payload?.finalTextMessage ?? "");
      else if (eventType === "internalFailureException" || eventType === "invalidRequestException") throw new Error(frameMessage(frame));
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
        const eventType = eventTypeOf(frame);
        if (eventType === "textMessageEvent") {
          const text = String(frame.payload?.textMessage ?? "");
          if (text) {
            sent = true;
            controller.enqueue(encoder.encode(sse(chunkOf(id, model, created, { content: text }))));
          }
        } else if (eventType === "metadataEvent" && frame.payload?.finalTextMessage && !sent) {
          // A backend that only sends the final text still gives a complete
          // answer; an earlier delta stream is not repeated.
          sent = true;
          controller.enqueue(encoder.encode(sse(chunkOf(id, model, created, { content: String(frame.payload.finalTextMessage) }))));
        } else if (eventType === "internalFailureException" || eventType === "invalidRequestException") {
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

function modelList() {
  const out = {};
  for (const [key, model] of Object.entries(MODELS)) out[key] = modelConfig(model);
  return out;
}

export async function QuickPlugin(_input, _options = {}) {
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[ID] ??= {
        name: "AWS Quick",
        npm: "@ai-sdk/openai-compatible",
        api: "https://quicksight.us-east-1.amazonaws.com",
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
              message: "AWS account id (blank reads it from the browser session)",
              required: false,
              validate: (value) => (typeof value === "string" && value.trim() && !ACCOUNT.test(value.trim()) ? "Use 12 digits, or leave it blank" : undefined),
            },
            {
              key: "region",
              message: "AWS region",
              placeholder: DEFAULT_REGION,
              required: false,
              validate: (value) => (typeof value === "string" && value.trim() && !REGION.test(value.trim()) ? "Use a region like us-east-1" : undefined),
            },
          ],
          authorize(inputs, { signal } = {}) {
            return {
              url: QUICK_LOGIN,
              instructions: "Sign in to AWS Quick in the browser window that opens. This window closes by itself when Magpie has the session.",
              opened: true,
              callback: async (_code, options = {}) => {
                const { cookies } = await quickSession(options.signal ?? signal);
                const session = sessionFrom(cookies, inputs.accountId, inputs.region);
                if (session.error) return { type: "failed", error: session.error };
                return {
                  type: "success",
                  access: JSON.stringify(session.creds),
                  refresh: "",
                  expires: session.expires,
                  metadata: { accountId: session.accountId, region: session.region },
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
              placeholder: "aws-creds=...; aws-consoleInfo=...",
              validate: (value) => (typeof value === "string" && value.includes("aws-creds=") ? undefined : "The cookie needs its aws-creds value"),
            },
            {
              key: "accountId",
              message: "AWS account id (blank reads it from aws-consoleInfo)",
              required: false,
              validate: (value) => (typeof value === "string" && value.trim() && !ACCOUNT.test(value.trim()) ? "Use 12 digits, or leave it blank" : undefined),
            },
            {
              key: "region",
              message: "AWS region",
              placeholder: DEFAULT_REGION,
              required: false,
              validate: (value) => (typeof value === "string" && value.trim() && !REGION.test(value.trim()) ? "Use a region like us-east-1" : undefined),
            },
          ],
          authorize(inputs) {
            const session = sessionOf(inputs);
            if (session.error) return { type: "failed", error: session.error };
            return {
              type: "success",
              key: JSON.stringify(session.creds),
              metadata: { accountId: session.accountId, region: session.region },
            };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        const creds = parseJSON(auth?.type === "oauth" ? auth.access : auth?.key);
        const accountId = auth?.metadata?.accountId;
        const region = auth?.metadata?.region ?? DEFAULT_REGION;
        if (!creds?.accessKeyId || !creds?.secretAccessKey) throw new Error("Quick sign-in has no usable AWS credentials");
        if (!ACCOUNT.test(String(accountId ?? ""))) throw new Error("Quick sign-in has no AWS account id");

        return {
          baseURL: `https://quicksight.${region}.amazonaws.com`,
          fetch: async (input, init = {}) => {
            const request = input instanceof Request ? input : undefined;
            const source = init.body ?? (request ? await request.text() : undefined);
            const body = parseJSON(typeof source === "string" ? source : "");
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Expected a JSON chat-completions body" } }), {
                status: 400,
                headers: { "content-type": "application/json" },
              });
            }
            const signal = init.signal ?? request?.signal;
            const { model, response } = await quickChat({ creds, accountId, region }, body, signal);
            return answer(response, model, body.stream === true);
          },
        };
      },
    },
  };
}

export default QuickPlugin;
