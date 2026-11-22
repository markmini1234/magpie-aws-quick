// A small AWS event-stream reader for Quick's ChatOutputStream. The service
// encodes event headers in the event-stream framing and each payload in CBOR.

const decoder = new TextDecoder();
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(bytes, end = bytes.length) {
  let crc = 0xffffffff;
  for (let i = 0; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function headerValue(bytes, offset, type) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 0) return offset + 1 <= bytes.length && bytes[offset] !== 0;
  if (type === 1) return bytes[offset];
  if (type === 2) return view.getInt16(offset, false);
  if (type === 3) return view.getInt32(offset, false);
  if (type === 4) return Number(view.getBigInt64(offset, false));
  if (type === 5 || type === 6 || type === 7) {
    const length = type === 5 ? bytes[offset] : view.getUint16(offset, false);
    return type === 5 ? bytes.slice(offset + 1, offset + 1 + length) : decoder.decode(bytes.slice(offset + 2, offset + 2 + length));
  }
  if (type === 8) return Number(view.getBigInt64(offset, false));
  if (type === 9) return bytes.slice(offset, offset + 16);
  return undefined;
}

function decodeHeaders(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers = {};
  let at = start;
  while (at < end) {
    const nameLength = bytes[at++];
    const name = decoder.decode(bytes.slice(at, at + nameLength));
    at += nameLength;
    const type = bytes[at++];
    const value = headerValue(bytes, at, type);
    if (type === 5) at += 1 + bytes[at];
    else if (type === 6 || type === 7) at += 2 + view.getUint16(at, false);
    else if (type === 1) at += 1;
    else if (type === 2) at += 2;
    else if (type === 3) at += 4;
    else if (type === 4 || type === 8) at += 8;
    else if (type === 9) at += 16;
    else if (type !== 0) throw new Error(`unsupported event-stream header type ${type}`);
    headers[name] = value;
  }
  return headers;
}

function decodeCBOR(bytes) {
  let at = 0;

  function length(additional) {
    if (additional < 24) return additional;
    if (additional === 24) return bytes[at++];
    if (additional === 25) {
      const value = (bytes[at] << 8) | bytes[at + 1];
      at += 2;
      return value;
    }
    if (additional === 26) {
      const value = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
      at += 4;
      return value;
    }
    if (additional === 27) {
      let value = 0;
      for (let i = 0; i < 8; i++) value = value * 256 + bytes[at++];
      return value;
    }
    if (additional === 31) return null;
    throw new Error(`unsupported CBOR length ${additional}`);
  }

  function item() {
    const initial = bytes[at++];
    const major = initial >> 5;
    const additional = initial & 31;
    if (major === 0) return length(additional);
    if (major === 1) return -1 - length(additional);
    if (major === 2) {
      const size = length(additional);
      if (size === null) {
        const chunks = [];
        while (bytes[at] !== 0xff) chunks.push(item());
        at++;
        return chunks.reduce((all, chunk) => concat(all, chunk), new Uint8Array());
      }
      const out = bytes.slice(at, at + size);
      at += size;
      return out;
    }
    if (major === 3) {
      const size = length(additional);
      if (size === null) {
        let text = "";
        while (bytes[at] !== 0xff) text += item();
        at++;
        return text;
      }
      const text = decoder.decode(bytes.slice(at, at + size));
      at += size;
      return text;
    }
    if (major === 4) {
      const size = length(additional);
      if (size === null) {
        const out = [];
        while (bytes[at] !== 0xff) out.push(item());
        at++;
        return out;
      }
      const out = [];
      for (let i = 0; i < size; i++) out.push(item());
      return out;
    }
    if (major === 5) {
      const size = length(additional);
      const out = {};
      if (size === null) {
        while (bytes[at] !== 0xff) out[String(item())] = item();
        at++;
        return out;
      }
      for (let i = 0; i < size; i++) out[String(item())] = item();
      return out;
    }
    if (major === 6) {
      length(additional);
      return item();
    }
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22 || additional === 23) return null;
      if (additional === 25) {
        const half = (bytes[at] << 8) | bytes[at + 1];
        at += 2;
        const exponent = (half >> 10) & 31;
        const mantissa = half & 1023;
        const sign = half & 0x8000 ? -1 : 1;
        return sign * (exponent === 0 ? mantissa * 2 ** -24 : exponent === 31 ? 0 : (1024 + mantissa) * 2 ** (exponent - 25));
      }
      if (additional === 26) {
        const value = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getFloat32(0);
        at += 4;
        return value;
      }
      if (additional === 27) {
        const value = new DataView(bytes.buffer, bytes.byteOffset + at, 8).getFloat64(0);
        at += 8;
        return value;
      }
      if (additional === 31) return null;
      return null;
    }
    throw new Error(`unsupported CBOR major type ${major}`);
  }

  return item();
}

function decodeFrame(frame) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const total = view.getUint32(0, false);
  const headerLength = view.getUint32(4, false);
  if (total !== frame.length) throw new Error("event-stream frame length mismatch");
  if (crc32(frame, 8) !== view.getUint32(8, false)) throw new Error("event-stream prelude checksum mismatch");
  if (crc32(frame, total - 4) !== view.getUint32(total - 4, false)) throw new Error("event-stream message checksum mismatch");
  const headers = decodeHeaders(frame, 12, 12 + headerLength);
  const payloadStart = 12 + headerLength;
  const bytes = frame.slice(payloadStart, total - 4);
  const contentType = String(headers[":content-type"] ?? "");
  let payload = {};
  if (bytes.length) {
    if (contentType.includes("cbor")) payload = decodeCBOR(bytes);
    else {
      try {
        payload = JSON.parse(decoder.decode(bytes));
      } catch {
        payload = {};
      }
    }
  }
  return { headers, payload };
}

export async function* decodeEventStream(body) {
  if (!body) return;
  let buffer = new Uint8Array();
  for await (const chunk of body) {
    buffer = concat(buffer, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    while (buffer.length >= 12) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const total = view.getUint32(0, false);
      if (total < 16) throw new Error(`invalid event-stream frame length ${total}`);
      if (buffer.length < total) break;
      const frame = buffer.slice(0, total);
      buffer = buffer.slice(total);
      yield decodeFrame(frame);
    }
  }
  if (buffer.length) throw new Error("truncated event-stream frame");
}

export function eventTypeOf(frame) {
  return String(frame.headers[":exception-type"] ?? frame.headers[":event-type"] ?? "");
}

export function frameMessage(frame) {
  const type = eventTypeOf(frame) || "Quick";
  const message = frame.payload?.message ?? frame.payload?.Message ?? frame.headers[":error-message"];
  return typeof message === "string" && message ? `${type}: ${message}` : type;
}
