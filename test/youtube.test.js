import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useTempQuotaFile, resetQuotaFile, mockYouTube } from "./helpers.js";

useTempQuotaFile();
const { decodeEntities, isoDuration, ytFetch, searchVideos, getVideoDetails, getVideoDetailsBulk, getChannelUploads, listCaptions } =
  await import("../src/lib/youtube.js");
const { getUsage } = await import("../src/lib/quota.js");

let yt;
beforeEach(() => resetQuotaFile());
afterEach(() => yt?.restore());

describe("isoDuration", () => {
  const cases = [
    ["PT4M13S", 253],
    ["PT1H", 3600],
    ["PT1H2M3S", 3723],
    ["PT45S", 45],
    ["PT10M", 600],
    ["P1DT2H", 93600], // 24h+ livestream — used to come back null
    ["P0D", 0], // upcoming premiere
  ];
  for (const [input, seconds] of cases) {
    test(`${input} -> ${seconds}s`, () => assert.equal(isoDuration(input), seconds));
  }

  test("returns null for things that are not durations", () => {
    assert.equal(isoDuration("garbage"), null);
    assert.equal(isoDuration(""), null);
    assert.equal(isoDuration(undefined), null);
  });
});

describe("decodeEntities", () => {
  test("decodes the entities the YouTube API escapes", () => {
    assert.equal(decodeEntities("Salt &amp; Pepper"), "Salt & Pepper");
    assert.equal(decodeEntities("It&#39;s"), "It's");
    assert.equal(decodeEntities("&quot;hi&quot;"), '"hi"');
    assert.equal(decodeEntities("&lt;b&gt;"), "<b>");
  });

  test("does not double-decode (&amp;lt; is the literal text &lt;)", () => {
    assert.equal(decodeEntities("&amp;lt;"), "&lt;");
    assert.equal(decodeEntities("&amp;amp;"), "&amp;");
  });

  test("passes empty and missing values through", () => {
    assert.equal(decodeEntities(""), "");
    assert.equal(decodeEntities(undefined), undefined);
  });
});

describe("ytFetch", () => {
  test("sends the API key and drops empty params", async () => {
    yt = mockYouTube(() => ({ body: { items: [] } }));
    await ytFetch("MY-KEY", "videos", { part: "snippet", id: "abc", pageToken: undefined, q: "" });
    const url = yt.calls[0];
    assert.equal(url.pathname, "/youtube/v3/videos");
    assert.equal(url.searchParams.get("key"), "MY-KEY");
    assert.equal(url.searchParams.get("id"), "abc");
    assert.equal(url.searchParams.has("pageToken"), false);
    assert.equal(url.searchParams.has("q"), false);
  });

  test("throws a readable error and charges no quota on an API failure", async () => {
    yt = mockYouTube(() => ({ status: 403, body: { error: { message: "quotaExceeded" } } }));
    await assert.rejects(() => ytFetch("k", "search", {}), /YouTube API error \(403\): quotaExceeded/);
    assert.equal(getUsage().unitsUsed, 0);
  });
});

const searchItem = (n) => ({
  id: { videoId: `v${n}` },
  snippet: { title: `Title &amp; ${n}`, channelTitle: "Chan", channelId: "UC1", publishedAt: "2026-01-01T00:00:00Z", description: "d" },
});
const page = (start, count, next) => ({
  body: { pageInfo: { totalResults: 999 }, nextPageToken: next, items: Array.from({ length: count }, (_, i) => searchItem(start + i)) },
});

describe("searchVideos", () => {
  test("one small search is one page costing 100 quota units", async () => {
    yt = mockYouTube(() => page(0, 5));
    const r = await searchVideos("k", { query: "mcp", maxResults: 5 });
    assert.equal(r.items.length, 5);
    assert.equal(r.searchCalls, 1);
    assert.equal(r.quotaUnitsUsed, 100);
    assert.equal(getUsage().unitsUsed, 100);
    assert.equal(yt.calls[0].searchParams.get("maxResults"), "5");
  });

  test("100 results paginates into 2 pages costing 200 quota units", async () => {
    yt = mockYouTube((url) => (url.searchParams.get("pageToken") === "T2" ? page(50, 50) : page(0, 50, "T2")));
    const r = await searchVideos("k", { query: "mcp", maxResults: 100 });
    assert.equal(r.items.length, 100);
    assert.equal(r.searchCalls, 2);
    assert.equal(r.quotaUnitsUsed, 200);
    assert.equal(getUsage().unitsUsed, 200);
    assert.equal(yt.calls[1].searchParams.get("pageToken"), "T2");
  });

  test("stops early when YouTube runs out of results", async () => {
    yt = mockYouTube(() => page(0, 7));
    const r = await searchVideos("k", { query: "rare", maxResults: 50 });
    assert.equal(r.items.length, 7);
    assert.equal(r.searchCalls, 1);
    assert.equal(r.nextPageToken, null);
  });

  test("maps and decodes results, and forwards the date range and order", async () => {
    yt = mockYouTube(() => page(1, 1));
    const r = await searchVideos("k", {
      query: "mcp",
      order: "date",
      publishedAfter: "2026-01-01T00:00:00Z",
      publishedBefore: "2026-02-01T00:00:00Z",
      maxResults: 1,
    });
    assert.deepEqual(r.items[0], {
      videoId: "v1",
      title: "Title & 1",
      channelTitle: "Chan",
      channelId: "UC1",
      publishedAt: "2026-01-01T00:00:00Z",
      description: "d",
    });
    const p = yt.calls[0].searchParams;
    assert.equal(p.get("order"), "date");
    assert.equal(p.get("publishedAfter"), "2026-01-01T00:00:00Z");
    assert.equal(p.get("publishedBefore"), "2026-02-01T00:00:00Z");
    assert.equal(p.get("type"), "video");
  });
});

describe("getVideoDetails", () => {
  const video = (id, duration, stats, title = "T") => ({
    id,
    snippet: { title, channelTitle: "C", publishedAt: "2026-01-01T00:00:00Z" },
    statistics: stats,
    contentDetails: { duration },
  });

  test("converts counts to numbers, flags Shorts, and decodes titles", async () => {
    yt = mockYouTube(() => ({
      body: {
        items: [
          video("a", "PT59S", { viewCount: "10", likeCount: "2", commentCount: "1" }, "Q &amp; A"),
          video("b", "PT10M", { viewCount: "1000", likeCount: "5", commentCount: "0" }),
        ],
      },
    }));
    const items = await getVideoDetails("k", ["a", "b"]);
    assert.equal(items[0].title, "Q & A");
    assert.equal(items[0].viewCount, 10);
    assert.equal(items[0].isShort, true);
    assert.equal(items[1].durationSeconds, 600);
    assert.equal(items[1].isShort, false);
    assert.equal(yt.calls[0].searchParams.get("id"), "a,b");
  });

  test("hidden like counts come back null, not 0", async () => {
    yt = mockYouTube(() => ({ body: { items: [video("a", "PT5M", { viewCount: "7" })] } }));
    const [v] = await getVideoDetails("k", ["a"]);
    assert.equal(v.likeCount, null);
    assert.equal(v.commentCount, null);
  });

  test("a batch of IDs costs one unit", async () => {
    yt = mockYouTube(() => ({ body: { items: [] } }));
    await getVideoDetails("k", ["a", "b", "c"]);
    assert.equal(getUsage().unitsUsed, 1);
  });

  test("unknown IDs just yield an empty list", async () => {
    yt = mockYouTube(() => ({ body: {} }));
    assert.deepEqual(await getVideoDetails("k", ["nope"]), []);
  });

  test("getVideoDetailsBulk splits 120 IDs into chunks of 50", async () => {
    yt = mockYouTube(() => ({ body: { items: [] } }));
    await getVideoDetailsBulk("k", Array.from({ length: 120 }, (_, i) => `id${i}`));
    assert.equal(yt.calls.length, 3);
    assert.equal(yt.calls[0].searchParams.get("id").split(",").length, 50);
    assert.equal(yt.calls[2].searchParams.get("id").split(",").length, 20);
  });
});

describe("getChannelUploads", () => {
  test("looks up the uploads playlist, then lists it", async () => {
    yt = mockYouTube((url) =>
      url.pathname.endsWith("/channels")
        ? { body: { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] } }
        : {
            body: {
              nextPageToken: "N",
              items: [{ snippet: { title: "A &amp; B", publishedAt: "p1" }, contentDetails: { videoId: "v1", videoPublishedAt: "p2" } }],
            },
          }
    );
    const r = await getChannelUploads("k", { channelId: "UC1", maxResults: 3 });
    assert.deepEqual(r, { nextPageToken: "N", items: [{ videoId: "v1", title: "A & B", publishedAt: "p2" }] });
    assert.equal(yt.calls[1].searchParams.get("playlistId"), "UU123");
    assert.equal(yt.calls[1].searchParams.get("maxResults"), "3");
    assert.equal(getUsage().unitsUsed, 2);
  });

  test("an unknown channel returns an error object instead of throwing", async () => {
    yt = mockYouTube(() => ({ body: { items: [] } }));
    const r = await getChannelUploads("k", { channelId: "UCnope" });
    assert.match(r.error, /not found/i);
    assert.deepEqual(r.items, []);
  });
});

describe("listCaptions", () => {
  test("maps tracks, marks auto-generated ones, and costs 50 units", async () => {
    yt = mockYouTube(() => ({
      body: { items: [{ snippet: { language: "en", trackKind: "asr" } }, { snippet: { language: "fr", trackKind: "standard" } }] },
    }));
    const r = await listCaptions("k", "v1");
    assert.deepEqual(r, [
      { language: "en", trackKind: "asr", isAutoSynced: true },
      { language: "fr", trackKind: "standard", isAutoSynced: false },
    ]);
    assert.equal(getUsage().unitsUsed, 50);
  });
});
