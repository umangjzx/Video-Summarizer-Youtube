# youtube-mcp-server

A remote MCP server that wraps the YouTube Data API v3, for use as a **Custom Connector** in Claude Cowork / Claude Desktop / claude.ai.

## What it gives Claude

- `search_videos` — search by keyword, optional date range, sort order (relevance/date/viewCount). Supports up to 100 results per call via automatic pagination.
- `get_video_details` — batch view/like/comment counts + duration for up to 50 videos in 1 call
- `get_channel_uploads` — list recent uploads from a known channel
- `list_captions` — check whether captions exist (official API, metadata only)
- `get_transcript` — fetch transcript text for a single video (unofficial, see below)
- `get_transcripts_bulk` — fetch transcripts for up to 15 videos in one call (unofficial, see below)

## Transcripts: official vs unofficial

The official YouTube Data API only lets you **download** caption text for videos you own, via OAuth.
`list_captions` uses this official API and can confirm captions *exist* for any video, but can't fetch third-party transcript text.

`get_transcript` / `get_transcripts_bulk` instead pull from YouTube's **public caption/timedtext endpoint** — the same
mechanism the video player itself uses to render captions on-screen. No OAuth or API key required, no quota cost, and it
works for third-party videos with public/auto-generated captions. This is **not part of the official Data API** and is
outside YouTube's documented terms for programmatic access:
- It can silently break if YouTube changes its page structure.
- It fails cleanly (returns `available: false` with an error message) for videos with captions disabled, no captions, or private/restricted videos — this doesn't fail the whole batch in `get_transcripts_bulk`.
- Don't hammer it at high volume/concurrency — fetch in modest batches (the bulk tool caps at 15 per call for this reason).

For a batch workflow of 80-100 videos: call `search_videos` once (up to 100 results, ~2 search units), then call
`get_transcripts_bulk` in batches of ~10-15 video IDs, summarizing each batch before requesting the next rather than
pulling all transcripts into context at once.

## 1. Get a YouTube API key (free)

1. Go to console.cloud.google.com → create/select a project
2. APIs & Services → Library → enable "YouTube Data API v3"
3. APIs & Services → Credentials → Create Credentials → API Key
4. (Recommended) Restrict the key to the YouTube Data API v3

Quota: 10,000 units/day shared pool, plus a separate ~100 calls/day bucket specifically for `search.list`. Budget your search calls accordingly — `get_video_details` and `get_channel_uploads` are cheap (1 unit) and don't touch the search bucket.

## 2. Run it locally to test

```bash
npm install
YOUTUBE_API_KEY=your_real_key PORT=8080 npm start
```

Confirm it boots and lists tools:
```bash
curl -s -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## 3. Deploy it somewhere public

Cowork's custom connectors are **remote** — Anthropic's servers connect to your server over the public internet, not your laptop. Pick any host that gives you a public HTTPS URL and lets you set environment variables, e.g.:

- Render.com (free/low-cost web service)
- Railway.app
- Fly.io
- A small VPS with a reverse proxy (Caddy/nginx) for HTTPS

Set these environment variables on the host:
- `YOUTUBE_API_KEY` — your real key
- `MCP_AUTH_TOKEN` — a random secret string **you generate** (e.g. `openssl rand -hex 32`) — this stops strangers from finding your public URL and burning your quota
- `PORT` — usually set automatically by the host

Your MCP endpoint will be: `https://your-app.your-host.com/mcp`

## 4. Add it as a Custom Connector

In Claude (claude.ai, Desktop, or Cowork):
1. Settings → Connectors → Add custom connector
2. Enter your server URL: `https://your-app.your-host.com/mcp`
3. If you set `MCP_AUTH_TOKEN`, you'll need to pass it as a Bearer token — check the current Custom Connector UI for where to enter a header/token, since this is a newer field and may vary
4. Enable the connector for your conversation/Cowork task via the "+" → Connectors menu

## 5. Use it

Once enabled, your `video-research` skill (or any conversation) can call these tools directly instead of relying purely on browsing — ask Claude to use them, or reference them explicitly if it doesn't pick them up automatically:

> "Use the youtube-mcp-server tools to search for videos on [topic] published in [date range], then get view counts for the results."
