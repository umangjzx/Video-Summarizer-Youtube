import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useTempQuotaFile, resetQuotaFile, mockYouTube, rpc, callTool, toolJson } from "./helpers.js";

useTempQuotaFile();
const { createApp } = await import("../src/app.js");

const EXPECTED_TOOLS = [
  "get_channel_uploads",
  "get_quota_status",
  "get_transcript",
  "get_transcripts_bulk",
  "get_video_details",
  "list_captions",
  "search_videos",
];

function listen(opts) {
  return new Promise((resolve) => {
    const server = createApp({ apiKey: "test-key", ...opts }).listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

let yt;
beforeEach(() => resetQuotaFile());
afterEach(() => yt?.restore());

describe("MCP server (no auth)", () => {
  let app;
  before(async () => {
    app = await listen({ authToken: undefined });
  });
  after(() => app.close());

  test("lists all 7 tools", async () => {
    const r = await rpc(app.url, "tools/list");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.result.tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
  });

  test("answers initialize without a session (stateless)", async () => {
    const r = await rpc(app.url, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.serverInfo.name, "youtube-mcp-server");
  });

  // Regression: one shared McpServer used to throw "Already connected to a
  // transport" whenever a request arrived while another was still in flight (e.g. a
  // slow tool call), and the unhandled rejection killed the whole process. Fast
  // requests finish before the next arrives, so this one has to be held open.
  test("serves a request while a slow tool call is still in flight", async () => {
    yt = mockYouTube(() => ({ delayMs: 300, body: { items: [] } }));
    const slow = callTool(app.url, "get_video_details", { videoIds: ["abc"] });
    await new Promise((r) => setTimeout(r, 50)); // let the slow call get connected
    const quick = await rpc(app.url, "tools/list", {}, { id: 2 });
    assert.equal(quick.status, 200);
    assert.equal(quick.json.result.tools.length, 7);
    assert.equal((await slow).status, 200);
  });

  test("handles many overlapping requests without crashing", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => rpc(app.url, "tools/list", {}, { id: i + 1 })));
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(r.json.result.tools.length, 7);
    }
    // ...and the process is still serving afterwards.
    assert.equal((await rpc(app.url, "tools/list")).status, 200);
  });

  test("each response carries its own request id", async () => {
    const results = await Promise.all([11, 22, 33].map((id) => rpc(app.url, "tools/list", {}, { id })));
    assert.deepEqual(results.map((r) => r.json.id), [11, 22, 33]);
  });

  test("get_quota_status reports usage", async () => {
    const usage = toolJson(await callTool(app.url, "get_quota_status"));
    assert.equal(usage.unitsUsed, 0);
    assert.equal(usage.limit, 10_000);
  });

  test("get_video_details returns decoded data and charges 1 unit", async () => {
    yt = mockYouTube(() => ({
      body: {
        items: [
          {
            id: "abc",
            snippet: { title: "Q &amp; A", channelTitle: "C", publishedAt: "2026-01-01T00:00:00Z" },
            statistics: { viewCount: "5", likeCount: "1", commentCount: "0" },
            contentDetails: { duration: "PT2M" },
          },
        ],
      },
    }));
    const out = toolJson(await callTool(app.url, "get_video_details", { videoIds: ["abc"] }));
    assert.equal(out.items[0].title, "Q & A");
    assert.equal(out.items[0].viewCount, 5);
    assert.equal(toolJson(await callTool(app.url, "get_quota_status")).unitsUsed, 1);
  });

  test("search_videos reports real quota cost (not the old searchUnitsUsed)", async () => {
    yt = mockYouTube(() => ({
      body: { pageInfo: { totalResults: 1 }, items: [{ id: { videoId: "v1" }, snippet: { title: "t", channelTitle: "c", channelId: "u", publishedAt: "p", description: "d" } }] },
    }));
    const out = toolJson(await callTool(app.url, "search_videos", { query: "x", maxResults: 1 }));
    assert.equal(out.searchCalls, 1);
    assert.equal(out.quotaUnitsUsed, 100);
    assert.equal("searchUnitsUsed" in out, false);
  });

  test("a YouTube API failure comes back as a tool error and the server keeps serving", async () => {
    yt = mockYouTube(() => ({ status: 403, body: { error: { message: "quotaExceeded" } } }));
    const r = await callTool(app.url, "get_video_details", { videoIds: ["abc"] });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.isError, true);
    assert.match(r.json.result.content[0].text, /quotaExceeded/);
    yt.restore();
    assert.equal((await rpc(app.url, "tools/list")).status, 200);
  });

  test("invalid arguments are rejected without a server error", async () => {
    const r = await callTool(app.url, "get_video_details", { videoIds: [] });
    assert.ok(r.status < 500);
    assert.ok(r.json.error || r.json.result?.isError, "expected a validation error");
  });

  test("a malformed JSON body gets a JSON-RPC parse error and does not kill the server", async () => {
    const res = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: "{ not json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32700);
    assert.equal((await rpc(app.url, "tools/list")).status, 200);
  });

  test("answers CORS preflight so browser-based clients can connect", async () => {
    const res = await fetch(`${app.url}/mcp`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-headers"), /Mcp-Session-Id/);
  });

  test("tool descriptions state the real quota costs", async () => {
    const tools = (await rpc(app.url, "tools/list")).json.result.tools;
    const desc = (name) => tools.find((t) => t.name === name).description;
    assert.match(desc("search_videos"), /100 quota units/);
    assert.match(desc("list_captions"), /50 quota units/);
    assert.doesNotMatch(desc("get_video_details"), /category/i);
  });
});

describe("MCP server (bearer-token auth)", () => {
  let app;
  before(async () => {
    app = await listen({ authToken: "s3cret" });
  });
  after(() => app.close());

  test("rejects requests with no token", async () => {
    assert.equal((await rpc(app.url, "tools/list")).status, 401);
  });

  test("rejects the wrong token", async () => {
    assert.equal((await rpc(app.url, "tools/list", {}, { headers: { Authorization: "Bearer nope" } })).status, 401);
  });

  test("accepts the right token", async () => {
    const r = await rpc(app.url, "tools/list", {}, { headers: { Authorization: "Bearer s3cret" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.result.tools.length, 7);
  });
});
