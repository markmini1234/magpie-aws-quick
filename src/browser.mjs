// Browser-assisted Quick sign-in.
//
// Quick has no public OAuth client for third-party tools, and its login page
// only returns to quick.aws.com. So the plugin opens a dedicated Chrome
// profile itself, lets the user sign in there, and reads the session cookie
// through the DevTools protocol. The profile is kept between sign-ins, so a
// later login usually completes without typing anything.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const QUICK_LOGIN = "https://quick.aws.com/sn/start";
const WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function browserPath() {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : process.platform === "win32"
        ? [
            join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
            join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return candidates.find((path) => existsSync(path));
}

function profileDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const dir = join(base, "magpie", "quick-browser");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stopPrevious(dir) {
  if (process.platform === "win32") return;
  const listing = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  for (const line of listing.split("\n")) {
    if (!line.includes(`--user-data-dir=${dir}`)) continue;
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The browser already exited.
      }
    }
  }
}

async function waitForPort(dir, signal, deadline) {
  const file = join(dir, "DevToolsActivePort");
  for (;;) {
    if (signal?.aborted) throw new DOMException("the sign-in was cancelled", "AbortError");
    try {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Chrome writes the file after its first start.
    }
    if (Date.now() > deadline) throw new Error("Chrome did not start with a DevTools port");
    await sleep(200);
  }
}

async function pageTarget(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.find((page) => page.type === "page" && page.url.includes("quick.aws.com")) ?? list.find((page) => page.type === "page");
}

function connect(url, signal) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const abort = () => reject(new DOMException("the sign-in was cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    ws.onopen = () => {
      signal?.removeEventListener("abort", abort);
      resolve(ws);
    };
    ws.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(new Error("Could not connect to Chrome DevTools"));
    };
  });
}

function rpc(ws) {
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "DevTools request failed"));
    else pending.resolve(message.result);
  };
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestID = ++id;
      waiting.set(requestID, { resolve, reject });
      ws.send(JSON.stringify({ id: requestID, method, params }));
    });
}

async function cookiesOf(port, signal) {
  const page = await pageTarget(port);
  if (!page?.webSocketDebuggerUrl) throw new Error("Chrome has no page to read cookies from");
  const ws = await connect(page.webSocketDebuggerUrl, signal);
  try {
    const send = rpc(ws);
    await send("Network.enable");
    const found = await send("Network.getCookies", {
      urls: [
        "https://quick.aws.com/",
        "https://quick.aws.com/sn",
      ],
    });
    return new Map((found.cookies ?? []).map((cookie) => [cookie.name, cookie.value]));
  } finally {
    ws.close();
  }
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await sleep(400);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

// quickSession waits for a signed-in Quick tab and gives its Cookie header.
export async function quickSession(signal) {
  const binary = browserPath();
  if (!binary) throw new Error("Chrome, Edge, Chromium or Brave is needed for browser sign-in");
  const dir = profileDir();
  stopPrevious(dir);
  await sleep(500);
  rmSync(join(dir, "DevToolsActivePort"), { force: true });

  const proc = spawn(
    binary,
    [
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      QUICK_LOGIN,
    ],
    { stdio: "ignore" },
  );

  const deadline = Date.now() + WAIT_MS;
  let port;
  try {
    const failed = new Promise((_, reject) => proc.once("error", reject));
    failed.catch(() => {});
    port = await Promise.race([waitForPort(dir, signal, deadline), failed]);
    for (;;) {
      if (signal?.aborted) throw new DOMException("the sign-in was cancelled", "AbortError");
      let cookies = new Map();
      try {
        cookies = await cookiesOf(port, signal);
      } catch {
        // Chrome may still be creating its first page.
      }
      // The Quick web session is the JSESSIONID pair plus the account alias;
      // a signed-in tab has both.
      if (cookies.has("JSESSIONID") && cookies.has("qs-directory-alias")) {
        const header = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
        return { cookies, header };
      }
      if (Date.now() > deadline) {
        const seen = [...cookies.keys()];
        throw new Error(`Timed out waiting for the Quick sign-in (cookies seen: ${seen.join(", ") || "none"}).`);
      }
      await sleep(POLL_MS);
    }
  } finally {
    await stop(proc);
  }
}
