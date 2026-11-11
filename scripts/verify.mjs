#!/usr/bin/env node
// Checks that a running youtube-mcp-server answers correctly over HTTP.
// Works the same on Windows, macOS and Linux (no curl / shell-quoting involved).
//
//   node scripts/verify.mjs                          # http://localhost:8080
//   node scripts/verify.mjs https://my-domain.ngrok-free.dev
//   node scripts/verify.mjs https://my-domain.ngrok-free.dev --live
//
// --live   also calls get_video_details for one video (costs 1 YouTube quota unit)
// --token  bearer token, if the server was started with MCP_AUTH_TOKEN
//          (defaults to the MCP_AUTH_TOKEN environment variable)
//
// Exit code 0 = every check passed, 1 = something failed. Never prints secrets.

const EXPECTED_TOOLS = [
  "get_channel_uploads",
  "get_quota_status",
  "get_transcript",
  "get_transcripts_bulk",
  "get_video_details",
  "list_captions",
  "search_videos",
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--token");

const base = (positional[0] || `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, "").replace(/\/mcp$/, "");
const token = option("--token") || process.env.MCP_AUTH_TOKEN;
const live = flag("--live");

// The server answers with plain JSON or a single SSE "data:" frame.
function parse(text) {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const data = t
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("");
  return JSON.parse(data);
}

let id = 0;
async function rpc(method, params = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = parse(text);
  } catch {
    // not JSON — the caller reports status and a short body excerpt
  }
  return { status: res.status, json, text, headers: res.headers };
}

let failed = 0;
function report(ok, name, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    const why = e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message || e.message;
    report(false, name, `${why} — nothing is listening there, or the host is unreachable`);
  }
}

console.log(`Verifying ${base}/mcp${token ? " (with bearer token)" : ""}\n`);

await check("server reachable and lists tools", async () => {
  const r = await rpc("tools/list");
  if (r.status === 404 && /ngrok/i.test(r.text)) {
    const code = r.headers.get("ngrok-error-code") || "";
    return report(false, "server reachable and lists tools", `ngrok says the endpoint is offline (${code}) — the tunnel is not running or serves a different domain`);
  }
  if (r.status === 401) return report(false, "server reachable and lists tools", "401 — the server requires a bearer token (use --token or MCP_AUTH_TOKEN)");
  if (r.status !== 200 || !r.json?.result) {
    return report(false, "server reachable and lists tools", `HTTP ${r.status}: ${r.text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  const names = r.json.result.tools.map((t) => t.name).sort();
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  report(missing.length === 0, "server reachable and lists tools", missing.length ? `missing: ${missing.join(", ")}` : `${names.length} tools`);
});

await check("get_quota_status works (free)", async () => {
  const r = await rpc("tools/call", { name: "get_quota_status", arguments: {} });
  const u = r.json?.result?.content?.[0]?.text ? JSON.parse(r.json.result.content[0].text) : null;
  report(Boolean(u && u.limit === 10000), "get_quota_status works (free)", u ? `${u.unitsUsed}/${u.limit} units used today` : `HTTP ${r.status}`);
});

await check("overlapping requests do not crash the server", async () => {
  const rs = await Promise.all(Array.from({ length: 10 }, () => rpc("tools/list")));
  const ok = rs.every((r) => r.status === 200);
  report(ok, "overlapping requests do not crash the server", ok ? "10/10 succeeded" : `statuses: ${rs.map((r) => r.status).join(",")}`);
});

if (live) {
  await check("YouTube API key works (get_video_details, 1 unit)", async () => {
    const r = await rpc("tools/call", { name: "get_video_details", arguments: { videoIds: ["dQw4w9WgXcQ"] } });
    const result = r.json?.result;
    if (result?.isError) {
      return report(false, "YouTube API key works (get_video_details, 1 unit)", result.content?.[0]?.text?.slice(0, 160));
    }
    const out = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : null;
    report(Boolean(out?.items?.[0]?.title), "YouTube API key works (get_video_details, 1 unit)", out?.items?.[0]?.title || `HTTP ${r.status}`);
  });
} else {
  console.log("SKIP  YouTube API key check (add --live to run it; costs 1 quota unit)");
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
