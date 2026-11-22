// A small Cookie jar for the Quick session.
//
// Quick rotates its session on the way through /sn/start: the reply carries
// new cookies, and the one the request went out with may be the session the
// server just replaced. A client that ignores Set-Cookie keeps handing over a
// dead session, which reads as "signed out" a few seconds after a successful
// sign-in.

export function jarOf(header) {
  const jar = new Map();
  for (const part of String(header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (name) jar.set(name, part.slice(at + 1).trim());
  }
  return jar;
}

export const headerOf = (jar) => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

function expired(attributes) {
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    if (at <= 0) continue;
    const name = attribute.slice(0, at).trim().toLowerCase();
    const value = attribute.slice(at + 1).trim();
    if (name === "max-age") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds <= 0) return true;
    }
    if (name === "expires") {
      // "Wed, 21 Oct 2015 07:28:00 GMT" holds a comma of its own.
      const when = Date.parse(value);
      if (Number.isFinite(when) && when <= Date.now()) return true;
    }
  }
  return false;
}

// applySetCookie returns header with every Set-Cookie line applied, as a
// browser would: a repeated name replaces the old value, and an expiry in the
// past (Quick's way of clearing a cookie) removes it.
export function applySetCookie(header, lines) {
  const jar = jarOf(header);
  for (const line of lines ?? []) {
    const [pair, ...attributes] = String(line).split(";");
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!name) continue;
    if (expired(attributes)) jar.delete(name);
    else jar.set(name, value);
  }
  return headerOf(jar);
}
