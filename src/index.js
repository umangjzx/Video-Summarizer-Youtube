import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { YoutubeTranscript } from "youtube-transcript";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
if (!YOUTUBE_API_KEY) {
  console.error("FATAL: YOUTUBE_API_KEY environment variable is not set.");
  process.exit(1);
}

// Optional shared-secret auth so randos on the internet can't call your server
// and burn your quota. Set MCP_AUTH_TOKEN on your host, and require it as a
// bearer token. Leave unset locally if you just want to test without auth.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

const YT_BASE = "https://www.googleapis.com/youtube/v3";

async function ytFetch(path, params) {
  const url = new URL(`${YT_BASE}/${path}`);
  url.searchParams.set("key", YOUTUBE_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok) {
    const reason = data?.error?.message || res.statusText;
    throw new Error(`YouTube API error (${res.status}): ${reason}`);
  }
  return data;
}

function isoDuration(pt) {
  // Convert ISO 8601 duration (e.g. PT4M13S) to seconds, roughly.
  const m = pt?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const s = parseInt(m[3] || "0", 10);
  return h * 3600 + min * 60 + s;
}

const server = new McpServer({
  name: "youtube-mcp-server",
  version: "1.0.0",
});

// ---- Tool: search_videos ----
server.tool(
  "search_videos",
  "Search YouTube for videos matching a query, optionally restricted to a publish date range. " +
    "Each 50 results costs 1 unit against the dedicated search bucket (~100 calls/day) — requesting " +
    "e.g. 100 results uses 2 units. Returns lightweight results (id, title, channel, publish date) — " +
    "call get_video_details for view counts/duration, or get_transcripts_bulk for transcript text.",
  {
    query: z.string().describe("Search query, e.g. 'AI stock market analysis'"),
    publishedAfter: z
      .string()
      .optional()
      .describe("ISO 8601 datetime, e.g. 2026-06-01T00:00:00Z. Only videos published after this."),
    publishedBefore: z
      .string()
      .optional()
      .describe("ISO 8601 datetime. Only videos published before this."),
    order: z
      .enum(["relevance", "date", "viewCount", "rating"])
      .optional()
      .describe("Sort order, default relevance."),
    maxResults: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe("Default 25, max 100. Values above 50 are fetched via automatic pagination (multiple API calls)."),
    pageToken: z.string().optional().describe("For pagination, pass nextPageToken from a prior call."),
  },
  async ({ query, publishedAfter, publishedBefore, order, maxResults, pageToken }) => {
    const target = maxResults || 25;
    const items = [];
    let nextPageToken = pageToken;
    let totalResultsEstimate;
    let callCount = 0;

    do {
      const data = await ytFetch("search", {
        part: "snippet",
        q: query,
        type: "video",
        order: order || "relevance",
        maxResults: Math.min(50, target - items.length),
        publishedAfter,
        publishedBefore,
        pageToken: nextPageToken,
      });
      callCount++;
      totalResultsEstimate = data.pageInfo?.totalResults;
      nextPageToken = data.nextPageToken || null;

      for (const it of data.items || []) {
        items.push({
          videoId: it.id.videoId,
          title: it.snippet.title,
          channelTitle: it.snippet.channelTitle,
          channelId: it.snippet.channelId,
          publishedAt: it.snippet.publishedAt,
          description: it.snippet.description,
        });
      }
    } while (items.length < target && nextPageToken);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              resultCount: items.length,
              totalResultsEstimate,
              nextPageToken,
              searchUnitsUsed: callCount,
              items,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Tool: get_video_details ----
server.tool(
  "get_video_details",
  "Get view count, like count, comment count, duration, and category for up to 50 video IDs at once. " +
    "Cheap: 1 unit per call regardless of how many IDs (batch these, don't call per-video).",
  {
    videoIds: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe("Up to 50 YouTube video IDs to fetch stats for in one call."),
  },
  async ({ videoIds }) => {
    const data = await ytFetch("videos", {
      part: "snippet,statistics,contentDetails",
      id: videoIds.join(","),
    });

    const items = (data.items || []).map((it) => {
      const seconds = isoDuration(it.contentDetails?.duration);
      return {
        videoId: it.id,
        title: it.snippet?.title,
        channelTitle: it.snippet?.channelTitle,
        publishedAt: it.snippet?.publishedAt,
        viewCount: it.statistics?.viewCount ? Number(it.statistics.viewCount) : null,
        likeCount: it.statistics?.likeCount ? Number(it.statistics.likeCount) : null,
        commentCount: it.statistics?.commentCount ? Number(it.statistics.commentCount) : null,
        durationSeconds: seconds,
        isShort: seconds !== null ? seconds < 180 : null,
      };
    });

    return { content: [{ type: "text", text: JSON.stringify({ items }, null, 2) }] };
  }
);

// ---- Tool: get_channel_uploads ----
server.tool(
  "get_channel_uploads",
  "List recent uploads from a specific channel (by channel ID). Useful when you already know a " +
    "relevant channel and want its recent videos without burning a search call.",
  {
    channelId: z.string().describe("YouTube channel ID (starts with UC...)."),
    maxResults: z.number().min(1).max(50).optional().describe("Default 25, max 50."),
    pageToken: z.string().optional(),
  },
  async ({ channelId, maxResults, pageToken }) => {
    // Resolve the channel's uploads playlist, then list it. 1 unit + 1 unit.
    const chData = await ytFetch("channels", { part: "contentDetails", id: channelId });
    const uploadsPlaylistId =
      chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: "Channel not found or has no uploads playlist." }) },
        ],
      };
    }

    const plData = await ytFetch("playlistItems", {
      part: "snippet,contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: maxResults || 25,
      pageToken,
    });

    const items = (plData.items || []).map((it) => ({
      videoId: it.contentDetails?.videoId,
      title: it.snippet?.title,
      publishedAt: it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ nextPageToken: plData.nextPageToken || null, items }, null, 2),
        },
      ],
    };
  }
);

// ---- Tool: list_captions ----
server.tool(
  "list_captions",
  "List available caption tracks for a video (languages/types only — does NOT return transcript " +
    "text). IMPORTANT LIMITATION: the official YouTube Data API only allows downloading caption " +
    "text for videos you own via OAuth. For third-party videos, this tool can confirm captions " +
    "exist but cannot fetch the transcript text — use web browsing/search for that instead.",
  {
    videoId: z.string(),
  },
  async ({ videoId }) => {
    const data = await ytFetch("captions", { part: "snippet", videoId });
    const items = (data.items || []).map((it) => ({
      language: it.snippet?.language,
      trackKind: it.snippet?.trackKind,
      isAutoSynced: it.snippet?.trackKind === "asr",
    }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              note: "Track list only. Downloading text requires OAuth + channel ownership.",
              items,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Fetches a transcript via YouTube's public caption endpoint (no OAuth/API key).
// This is NOT part of the official Data API and can break if YouTube changes its
// page structure, or fail for videos with captions disabled/unavailable.
async function fetchTranscriptText(videoId, lang, maxChars) {
  const segments = await YoutubeTranscript.fetchTranscript(videoId, lang ? { lang } : undefined);
  let text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  const truncated = maxChars && text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return {
    segmentCount: segments.length,
    language: segments[0]?.lang || lang || null,
    transcript: text,
    truncated: Boolean(truncated),
  };
}

// ---- Tool: get_transcript ----
server.tool(
  "get_transcript",
  "Fetch the transcript/caption text for a single video via YouTube's public caption endpoint " +
    "(unofficial — not part of the Data API, no quota cost, but can fail or break without notice). " +
    "Use get_transcripts_bulk when processing many videos.",
  {
    videoId: z.string().describe("YouTube video ID."),
    lang: z.string().optional().describe("Preferred caption language code, e.g. 'en'. Defaults to the video's first available track."),
    maxChars: z.number().min(500).optional().describe("Truncate transcript text to this many characters. Default: no truncation."),
  },
  async ({ videoId, lang, maxChars }) => {
    try {
      const result = await fetchTranscriptText(videoId, lang, maxChars);
      return { content: [{ type: "text", text: JSON.stringify({ videoId, available: true, ...result }, null, 2) }] };
    } catch (e) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ videoId, available: false, error: e.message }, null, 2) },
        ],
      };
    }
  }
);

// ---- Tool: get_transcripts_bulk ----
server.tool(
  "get_transcripts_bulk",
  "Fetch transcripts for multiple videos at once (unofficial caption endpoint, see get_transcript). " +
    "Capped at 15 per call to keep responses manageable and avoid rate-limiting the unofficial endpoint — " +
    "when processing 80-100 videos, call this repeatedly in batches of ~10-15, summarizing each batch " +
    "before requesting the next rather than fetching all transcripts up front. Per-video failures " +
    "(captions disabled, unavailable) are returned inline and don't fail the whole batch.",
  {
    videoIds: z.array(z.string()).min(1).max(15).describe("Up to 15 YouTube video IDs."),
    lang: z.string().optional().describe("Preferred caption language code, e.g. 'en'."),
    maxChars: z.number().min(500).optional().describe("Truncate each transcript to this many characters. Default: 20000."),
  },
  async ({ videoIds, lang, maxChars }) => {
    const cap = maxChars || 20000;
    const results = await Promise.all(
      videoIds.map(async (videoId) => {
        try {
          const result = await fetchTranscriptText(videoId, lang, cap);
          return { videoId, available: true, ...result };
        } catch (e) {
          return { videoId, available: false, error: e.message };
        }
      })
    );
    return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
  }
);

// ---- HTTP transport wiring ----
const app = express();

// Remote MCP clients (claude.ai / Cowork running in a browser context) call this
// endpoint cross-origin, so it needs CORS headers or the browser blocks the request
// before it ever reaches Express — this shows up client-side as a generic
// "couldn't connect" / "couldn't register" error with nothing useful in server logs.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Accept, Last-Event-ID");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());

app.all("/mcp", async (req, res) => {
  if (MCP_AUTH_TOKEN) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${MCP_AUTH_TOKEN}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.error(`youtube-mcp-server listening on port ${PORT}, endpoint: /mcp`);
});
