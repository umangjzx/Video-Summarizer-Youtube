import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { searchVideos, getVideoDetails, getChannelUploads, listCaptions } from "./lib/youtube.js";
import { fetchTranscriptText, fetchTranscriptsSequential } from "./lib/transcripts.js";
import { getUsage } from "./lib/quota.js";

// A McpServer instance can only be connected to one transport at a time, and this
// server is stateless (one transport per HTTP request). Sharing a single instance
// across requests crashes the process with "Already connected to a transport" as
// soon as two requests overlap, so build a fresh one per request.
export function createServer(apiKey) {
  const server = new McpServer({
    name: "youtube-mcp-server",
    version: "1.0.0",
  });

  // ---- Tool: search_videos ----
  server.tool(
    "search_videos",
    "Search YouTube for videos matching a query, optionally restricted to a publish date range. " +
      "EXPENSIVE: every page of up to 50 results costs 100 quota units out of the 10,000/day budget " +
      "(so maxResults 50 = 100 units, maxResults 100 = 200 units; at most ~100 pages per day). Prefer " +
      "get_channel_uploads when you already know the channel. Returns lightweight results (id, title, " +
      "channel, publish date) — call get_video_details for view counts/duration, or " +
      "get_transcripts_bulk for transcript text.",
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
      const result = await searchVideos(apiKey, args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                resultCount: result.items.length,
                totalResultsEstimate: result.totalResultsEstimate,
                nextPageToken: result.nextPageToken,
                searchCalls: result.searchCalls,
                quotaUnitsUsed: result.quotaUnitsUsed,
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
    "Get view count, like count, comment count, duration, and an isShort flag for up to 50 video IDs at once. " +
      "Cheap: 1 unit per call regardless of how many IDs (batch these, don't call per-video).",
    {
      videoIds: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Up to 50 YouTube video IDs to fetch stats for in one call."),
    },
    async ({ videoIds }) => {
      const items = await getVideoDetails(apiKey, videoIds);
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
      const result = await getChannelUploads(apiKey, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ---- Tool: list_captions ----
  server.tool(
    "list_captions",
    "List available caption tracks for a video (languages/types only — does NOT return transcript " +
      "text). Costs 50 quota units per call, and the official API only allows downloading caption " +
      "text for videos you own via OAuth, so this is rarely worth calling. To read what a video " +
      "says, use get_transcript / get_transcripts_bulk instead (free, no quota).",
    {
      videoId: z.string(),
    },
    async ({ videoId }) => {
      const items = await listCaptions(apiKey, videoId);
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
      "Returns English captions whenever the video has any (including en-US / en-GB). If it has none, " +
      "the original-language text is returned with needsTranslation: true — then translate it into " +
      "English yourself before summarizing. Use get_transcripts_bulk when processing many videos.",
    {
      videoId: z.string().describe("YouTube video ID."),
      lang: z.string().optional().describe("Preferred caption language code. Defaults to 'en'; if that isn't available the best available track is returned and flagged with needsTranslation."),
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
      "(captions disabled, unavailable) are returned inline and don't fail the whole batch. English " +
      "captions are used whenever they exist; any result with needsTranslation: true is in another " +
      "language and must be translated into English by you before summarizing.",
    {
      videoIds: z.array(z.string()).min(1).max(15).describe("Up to 15 YouTube video IDs."),
      lang: z.string().optional().describe("Preferred caption language code. Defaults to 'en'; falls back to the best available track, flagged with needsTranslation."),
      maxChars: z.number().min(500).optional().describe("Truncate each transcript to this many characters. Default: 20000."),
    },
    async ({ videoIds, lang, maxChars }) => {
      const results = await fetchTranscriptsSequential(videoIds, { lang, maxChars: maxChars || 20000 });
      return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
    }
  );

  return server;
}

// ---- HTTP transport wiring ----
//
// authToken: optional shared-secret auth so randos on the internet can't call your
// server and burn your quota; callers must send it as a bearer token. Leave unset
// locally if you just want to test without auth.
//
// NOTE: as of this writing, Claude's Custom Connector dialog only supports "no auth"
// or full OAuth (Client ID/Secret) — there's no field for a static bearer token, so
// this can't actually be used with a Cowork/claude.ai connector yet. Leave unset for
// that use case; this remains available for direct API callers that can set headers.
export function createApp({ apiKey, authToken = process.env.MCP_AUTH_TOKEN }) {
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
    if (authToken) {
      const auth = req.headers["authorization"];
      if (auth !== `Bearer ${authToken}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    try {
      const server = createServer(apiKey);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("Error handling /mcp request:", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Errors raised before the route runs (chiefly body-parser rejecting malformed
  // JSON) would otherwise get Express's HTML error page plus a stack trace in the
  // logs. Answer in JSON-RPC like everything else on this endpoint.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const clientError = err?.status >= 400 && err.status < 500;
    if (!clientError) console.error("Unhandled error:", err);
    res.status(clientError ? err.status : 500).json({
      jsonrpc: "2.0",
      error: clientError
        ? { code: err.type === "entity.parse.failed" ? -32700 : -32600, message: err.type === "entity.parse.failed" ? "Parse error: request body is not valid JSON" : "Invalid request" }
        : { code: -32603, message: "Internal server error" },
      id: null,
    });
  });

  return app;
}
