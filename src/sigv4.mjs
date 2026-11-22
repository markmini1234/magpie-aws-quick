// AWS Signature Version 4 with node:crypto only. This is the same signing
// shape Magpie's AWS Bedrock SSO plugin uses, for the "quicksight" service.
import { createHash, createHmac } from "node:crypto";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalPath(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.split("/").map((segment) => enc(segment)).join("/");
}

function canonicalQuery(params) {
  return [...params.entries()]
    .map(([key, value]) => [enc(key), enc(value)])
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function signRequest(req, creds, { region, service, now = new Date() }) {
  const url = typeof req.url === "string" ? new URL(req.url) : req.url;
  const method = (req.method || "GET").toUpperCase();
  const body = req.body ?? "";
  const payloadHash = sha256(body);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);

  const headers = new Headers(req.headers);
  headers.set("host", url.host);
  headers.set("x-amz-date", amzDate);
  headers.set("x-amz-content-sha256", payloadHash);
  if (creds.sessionToken) headers.set("x-amz-security-token", creds.sessionToken);
  else headers.delete("x-amz-security-token");
  headers.delete("authorization");

  const signed = ["host", "x-amz-date", "x-amz-content-sha256", "content-type"];
  if (creds.sessionToken) signed.push("x-amz-security-token");
  const names = signed.filter((name) => headers.has(name)).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers.get(name).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [method, canonicalPath(url.pathname), canonicalQuery(url.searchParams), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  headers.delete("host");
  return headers;
}
