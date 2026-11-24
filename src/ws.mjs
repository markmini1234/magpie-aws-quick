// Quick's full agent channel: ChatBidirectionalStream over WebSocket.
//
// The plain HTTP /conversations/chat endpoint is a light inference path — it
// prefixes its own "You are Quick" system layer and drops the caller's. The
// web UI uses this WebSocket instead, and it is what carries the real agent:
// memory, tools, agent_mode, thinking_effort, web_search_enabled and the
// custom_prompt the user sets in the UI. Events on the wire are AWS event
// stream frames whose payload is CBOR; each payload holds one JSON message
// (user_message, text_delta, tool_start, turn_usage, message_complete...).
//
// This module speaks that protocol: it encodes outgoing user_message frames
// and decodes the incoming stream into the OpenAI-shaped events the plugin
// already knows how to serve.

import { decodeEventStream, eventTypeOf } from "./eventstream.mjs";
import { applySetCookie } from "./cookies.mjs";

const decoder = new TextDecoder();

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b };
const cborBytes = (bytes) => Buffer.concat([Buffer.from([0x59]), u16(bytes.length), bytes]);

// One outbound frame: an AWS event-stream message whose payload is
// {"payload": <cbor-encoded JSON>} under the rawInputEvent type.
function encodeFrame(obj) {
  const payload = cborBytes(Buffer.from(JSON.stringify(obj)));
  const headers = [
    [":event-type", "rawInputEvent"],
    [":content-type", "application/cbor"],
    [":message-type", "event"],
  ].map(([name, value]) => Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7]), u16(value.length), Buffer.from(value)]));
  const h = Buffer.concat(headers);
  const total = 16 + h.length + payload.length;
  const prelude = Buffer.concat([u32(total), u32(h.length)]);
  const body = Buffer.concat([prelude, u32(crc32(prelude)), h, payload]);
  return Buffer.concat([body, u32(crc32(body))]);
}

// Load the ws package once; Magpie bundles its own node_modules.
let WebSocketImpl;
async function wsImpl() {
  if (WebSocketImpl) return WebSocketImpl;
  const mod = await import("ws");
  WebSocketImpl = mod.default ?? mod.WebSocket;
  return WebSocketImpl;
}

// agentChat sends one user message over Quick's agent channel and resolves
// with the final text plus the metadata the caller needs for usage display.
// It owns a single WebSocket for the life of the request: open, send
// session_connect + user_message, read until message_complete, close.
export async function agentChat({ origin = "https://quick.aws.com", cookie, alias, csrf, question, systemPrompt = "", agentMode = "smart", thinking = "off", agentId, signal, timezone = "Asia/Shanghai", locale = "zh-CN", onDelta, onTool }) {
  const WS = await wsImpl();
  const thread = crypto.randomUUID();
  const url =
    `${origin.replace(/^http/, "ws")}/sn/account/${encodeURIComponent(alias)}/wsproxy/service/SpaceNeedleConversationService/operation/ChatBidirectionalStream?` +
    new URLSearchParams({
      "wsproxy-protocol": "rpc-v2-cbor",
      awsAccountId: alias,
      surfaceType: "WEB_EXPERIENCE",
      agentServiceType: "UNIFIED_QUICK",
      outpostId: "web0",
      workingSessionId: thread,
      mbtc: csrf,
    });
  const proto = encodeURIComponent(JSON.stringify({ csrfToken: encodeURIComponent(csrf) }));

  return await new Promise((resolve, reject) => {
    let settled = false;
    let text = "";
    let model = "";
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Quick agent channel timed out")), 120_000);
    const onAbort = () => finish(new Error("Quick agent channel aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });

    const socket = new WS(url, ["subprotocol-json", proto], {
      headers: { Cookie: cookie, Origin: origin },
    });

    socket.on("open", () => {
      const common = { appVersion: "qbiz-web-bridge", acp_first_text: 1, user_notification: 1, subtask_progress: 1, external_agent_sign_in: 1, recents_promotion: 1, self_registering_connectors: 1 };
      socket.send(encodeFrame({ type: "session_connect", payload: { session_id: thread } }));
      socket.send(encodeFrame({ type: "session_connect", payload: { session_id: thread, focus_only: true, ...common } }));
      socket.send(encodeFrame({ type: "dock_state_sync", payload: { session_id: thread, files: [], focused_file: "", sidebar_open: false, surfaceType: "WEB_EXPERIENCE" } }));
      socket.send(encodeFrame({
        type: "user_message",
        payload: {
          traceId: crypto.randomUUID(),
          text: question,
          send_origin: "composer",
          had_physical_input: true,
          ...common,
          message_id: `msg-${crypto.randomUUID().slice(0, 8)}`,
          thread_id: thread,
          agent_mode: agentMode,
          thinking_effort: thinking,
          user_timezone: timezone,
          user_locale: locale,
          // Quick's UI field for "my assistant's own instructions". The
          // account's system layer accepts this where it rewrites the same
          // text pasted into the message body.
          custom_prompt: systemPrompt || null,
          chat_agent_id: agentId,
          auto_routing: false,
          web_search_enabled: true,
          direct_chat: false,
          voice_mode: false,
          voice_id: "matthew",
          tts_speed: 1.1,
        },
      }));
    });

    socket.on("message", async (data) => {
      const buf = Buffer.from(data);
      try {
        for await (const frame of decodeEventStream(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close(); } }))) {
          const p = frame.payload ?? {};
          const raw = p.payload instanceof Uint8Array ? decoder.decode(p.payload) : p.payload;
          let obj = raw;
          if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch {} }
          const frameType = eventTypeOf(frame);
          if (frameType === "limitExceededException") {
            finish(Object.assign(new Error("Quick agent channel refused the connection: too many active connections (max 3 per account). The account is in use elsewhere (likely an open browser tab); retry in a moment."), { status: 429 }));
            return;
          }
          if (frameType === "internalFailureException" || frameType === "validationException") {
            finish(new Error(`Quick agent channel error: ${JSON.stringify(p).slice(0, 200)}`));
            return;
          }
          if (obj?.type === "session_established") continue;
          if (!obj || typeof obj !== "object") continue;
          if (obj.type === "text_delta") {
            const part = String(obj.payload?.delta ?? "");
            if (part) { text += part; onDelta?.(part); }
          } else if (obj.type === "text_complete") {
            text = String(obj.payload?.text ?? text);
          } else if (obj.type === "tool_start" || obj.type === "tool_result") {
            onTool?.(obj);
          } else if (obj.type === "turn_usage") {
            model = String(obj.payload?.resolved_model_id ?? obj.payload?.served_model_id ?? model);
          } else if (obj.type === "message_complete") {
            finish(null, { text: String(obj.payload?.text ?? text), model, thread });
            return;
          } else if (obj.type === "error" || obj.type === "internalFailureException") {
            finish(new Error(String(obj.payload?.message ?? obj.payload ?? "Quick agent channel error")));
            return;
          }
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => { if (!settled) finish(new Error("Quick agent channel closed before message_complete")); });
  });
}
