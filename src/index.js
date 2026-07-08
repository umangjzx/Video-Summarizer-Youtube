import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { requireApiKey } from "./lib/env.js";
import { searchVideos, getVideoDetails, getChannelUploads, listCaptions } from "./lib/youtube.js";
import { fetchTranscriptText, fetchTranscriptsSequential } from "./lib/transcripts.js";
import { getUsage } from "./lib/quota.js";

const YOUTUBE_API_KEY = requireApiKey();

// Optional shared-secret auth so randos on the internet can't call your server
// and burn your quota. Set MCP_AUTH_TOKEN on your host, and require it as a
// bearer token. Leave unset locally if you just want to test without auth.
//
// NOTE: as of this writing, Claude's Custom Connector dialog only supports "no auth"
// or full OAuth (Client ID/Secret) — there's no field for a static bearer token, so
// this can't actually be used with a Cowork/claude.ai connector yet. Leave unset for
// that use case; this remains available for direct API callers that can set headers.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

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
  async (args) => {
    const result = await searchVideos(YOUTUBE_API_KEY, args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              resultCount: result.items.length,
              totalResultsEstimate: result.totalResultsEstimate,
              nextPageToken: result.nextPageToken,
              searchUnitsUsed: result.searchUnitsUsed,
              items: result.items,
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
    const items = await getVideoDetails(YOUTUBE_API_KEY, videoIds);
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
  async (args) => {
    const result = await getChannelUploads(YOUTUBE_API_KEY, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
    const items = await listCaptions(YOUTUBE_API_KEY, videoId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { note: "Track list only. Downloading text requires OAuth + channel ownership.", items },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ---- Tool: get_quota_status ----
server.tool(
  "get_quota_status",
  "Check today's YouTube Data API quota usage (resets at midnight Pacific Time). Call this before " +
    "a large search/digest run to confirm there's enough quota left — search.list costs 100 units, " +
    "videos/channels/playlistItems cost 1 unit, captions.list costs 50. The daily limit is 10,000 " +
    "units shared across all of it. Transcript fetching (get_transcript/get_transcripts_bulk) does " +
    "not touch this quota at all.",
  {},
  async () => {
    return { content: [{ type: "text", text: JSON.stringify(getUsage(), null, 2) }] };
  }
);

// ---- Tool: get_transcript ----
server.tool(
  "get_transcript",
  "Fetch the transcript/caption text for a single video via YouTube's public caption endpoint " +
    "(unofficial — not part of the Data API, no quota cost, but can fail or break without notice, " +
    "and gets CAPTCHA-blocked reliably when this server runs on a cloud host — see README). " +
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
    const results = await fetchTranscriptsSequential(videoIds, { lang, maxChars: maxChars || 20000 });
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
