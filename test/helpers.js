import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the quota tracker at a throwaway file so tests never read or clobber the
// real .quota-usage.json. Returns the path (and starts each call from a clean slate).
export function useTempQuotaFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-mcp-test-"));
  const file = path.join(dir, "quota.json");
  process.env.QUOTA_FILE = file;
  return file;
}

export function resetQuotaFile() {
  fs.rmSync(process.env.QUOTA_FILE, { force: true });
}

const realFetch = globalThis.fetch;

// Replace global fetch for requests to the YouTube Data API only; anything else
// (e.g. the test client talking to the local server) goes through to the real fetch.
// handler(url: URL) -> { status?: number, body: object, delayMs?: number }
// delayMs holds the response back, which is how tests keep a request in flight.
export function mockYouTube(handler) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "www.googleapis.com") return realFetch(input, init);
    calls.push(url);
    const { status = 200, body, delayMs = 0 } = handler(url);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

// ---- MCP-over-HTTP test client ----

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

// The server answers with either JSON or a single SSE "data:" frame.
function parseBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("");
  return data ? JSON.parse(data) : null;
}

export async function rpc(baseUrl, method, params = {}, { headers = {}, id = 1 } = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = parseBody(text);
  } catch {
    // non-JSON body (e.g. an HTML error page) — leave json null, callers check status
  }
  return { status: res.status, json, text, headers: res.headers };
}

export async function callTool(baseUrl, name, args = {}, opts) {
  const r = await rpc(baseUrl, "tools/call", { name, arguments: args }, opts);
  return r;
}

// Text payload of a tool result, parsed as JSON.
export function toolJson(r) {
  return JSON.parse(r.json.result.content[0].text);
}
