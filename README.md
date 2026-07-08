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

### Known limitation: unreliable from cloud hosts (Render/Railway/etc.)

In practice, YouTube's anti-bot system treats requests from shared datacenter IPs (Railway, Render, AWS, GCP, ...) with
far more suspicion than residential IPs. Testing this server deployed on Railway: transcript fetches for real-world
videos failed almost every time with `"YouTube is receiving too many requests from this IP and now requires solving a
captcha"`, regardless of throttling/sequencing — while the exact same calls succeeded 100% of the time run locally from
a residential connection. (One globally-scraped test video, `dQw4w9WgXcQ`, consistently succeeds even from the cloud —
almost certainly because it's cached/whitelisted from being the most-used scraping test video on the internet. It is
not representative of real videos.)

**Practical implication:** treat `get_transcript`/`get_transcripts_bulk` as best-effort when called through a remote
deployment. For a Custom Connector used by Cowork, expect transcript-based summaries to mostly fall back to
metadata-only (title/description) — the `video-digest` skill already does this gracefully. If you need reliable
transcript-depth summaries, run that part of the workflow from a local session (e.g. Claude Code on your own machine)
instead of through the remote connector, or route the server's outbound requests through a residential/rotating proxy
(added cost/complexity, not implemented here).

For a batch workflow of 80-100 videos: call `search_videos` once (up to 100 results, ~2 search units), then call
`get_transcripts_bulk` in batches of ~10-15 video IDs, summarizing each batch before requesting the next rather than
pulling all transcripts into context at once. Expect most of those transcript calls to fail if run through the remote
connector — plan for a metadata-only digest as the realistic baseline.

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
2. Enter your server URL — **including the `/mcp` path**: `https://your-app.your-host.com/mcp`. The dialog can render
   the saved URL without the path in its detail view, which is misleading — if the connector fails to register, double
   check the URL field genuinely ends in `/mcp` before troubleshooting anything else.
3. As of this writing, the custom connector dialog only supports **no auth** or full **OAuth (Client ID/Secret)** —
   there is no field for a static bearer token. If you set `MCP_AUTH_TOKEN` on your host, Claude has no way to send it
   and every call will 401. For a personal/single-user connector, the practical option is to leave `MCP_AUTH_TOKEN`
   unset (no auth) rather than implement full OAuth. Also turn off "Individual sign-in" in the connector's advanced
   settings — leaving it on makes Claude attempt an OAuth handshake your server doesn't implement, which surfaces as a
   "couldn't register with sign-in service" error even when the server itself is reachable.
4. The server must send CORS headers (already handled in `src/index.js`) since the connecting client calls it
   cross-origin — without this, connection attempts fail client-side with a generic, hard-to-diagnose error.
5. Enable the connector for your conversation/Cowork task via the "+" → Connectors menu

## 5. Use it

Once enabled, your `video-research` skill (or any conversation) can call these tools directly instead of relying purely on browsing — ask Claude to use them, or reference them explicitly if it doesn't pick them up automatically:

> "Use the youtube-mcp-server tools to search for videos on [topic] published in [date range], then get view counts for the results."
