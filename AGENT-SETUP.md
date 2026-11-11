# Agent setup guide: youtube-mcp-server

**If you are an AI agent, read this whole file before running anything.** It tells you how to get this project
running on a machine, connect it to Claude, and prove it works. Follow the rules in section 2 exactly. If a step
here conflicts with what the user told you, the user wins; ask rather than guess.

## 1. What this project is

A Node.js (ES modules) MCP server that wraps the YouTube Data API v3 and exposes it at `POST /mcp` (Streamable
HTTP, stateless). Claude connects to it as a Custom Connector (claude.ai / Desktop / Cowork) or via
`claude mcp add` (Claude Code).

| Tool | What it does | YouTube quota cost |
|---|---|---|
| `search_videos` | Keyword search, optional date range, up to 100 results | **100 units per page of 50** (100 results = 200) |
| `get_video_details` | Views/likes/comments/duration for up to 50 IDs | 1 unit per call |
| `get_channel_uploads` | Recent uploads for a channel ID | 2 units |
| `list_captions` | Which caption tracks exist (no text) | 50 units |
| `get_transcript` | Transcript text for one video (unofficial endpoint) | 0 |
| `get_transcripts_bulk` | Transcripts for up to 15 videos | 0 |
| `get_quota_status` | Today's usage of the 10,000-unit daily quota | 0 |

Key facts that explain how setup works:

- The YouTube API key lives in `.env` (`YOUTUBE_API_KEY`). `.env` is **gitignored**, so a fresh clone does not have it.
- Claude's connector calls the server **from Anthropic's cloud**, so `localhost` is unreachable to it. For claude.ai /
  Desktop / Cowork the server must be exposed on a public HTTPS URL, here via an **ngrok** tunnel.
  Claude Code runs on the user's machine and can use `http://localhost:8080/mcp` directly.
- Transcripts use YouTube's unofficial caption endpoint and are **CAPTCHA-blocked from cloud/datacenter IPs**. They
  only work reliably when the server runs on a normal home/office connection. Do not move the server to a cloud host
  and expect transcripts to work.
- Quota usage is tracked in a local `.quota-usage.json` (gitignored), so it is per machine.

## 2. Rules (non-negotiable)

1. **Never read, print, log, paste or commit secrets.** That means `.env`, `main.env`, the YouTube API key, the ngrok
   authtoken, `MCP_AUTH_TOKEN`. Do not `cat .env`. To check the key exists, check that the file exists or run
   `npm run verify -- --live`, which proves the key works without printing it.
2. **The user supplies credentials, not you.** Ask the user to create `.env` themselves (give them the template in
   step B3) and to run `ngrok config add-authtoken <TOKEN>` themselves. Never ask them to paste a key or token into chat.
3. **Do not push, force-push, or change git remotes** unless the user asks. Commit only when asked.
4. **Starting a public tunnel exposes the server to the internet.** Confirm with the user before starting ngrok. If
   your environment refuses to run it, **stop and hand the user the exact command**; do not look for a way around the
   refusal.
5. **Do not add authentication, rate limiting or any other policy** the user did not ask for. (Note: Claude's custom
   connector dialog cannot send a bearer token, so setting `MCP_AUTH_TOKEN` makes every connector call fail with 401.)
6. **Do not spend YouTube quota speculatively.** `search_videos` costs 100 units. For verification use
   `get_quota_status` (free) and at most one `get_video_details` (1 unit).
7. Do not edit source files to make setup "work". If something fails, use section 7 to diagnose, then report.
8. Report outcomes honestly: if a check fails or you skipped a step, say so.

## 3. Pick a mode (ask the user if unclear)

- **Mode A: client only.** The server already runs on another machine and has a public URL. This machine just needs
  to be pointed at it. No code needed. Go to section 4.
- **Mode B: run the server here.** Go to section 5.

## 4. Mode A: connect this machine to an existing server

Get the server's public URL from the user (it ends in `/mcp`, e.g. `https://<name>.ngrok-free.dev/mcp`).

1. Check it is up (from the repo if cloned, otherwise any HTTP client):
   `node scripts/verify.mjs https://<name>.ngrok-free.dev`
2. **Claude Code on this machine:**
   `claude mcp add --transport http youtube https://<name>.ngrok-free.dev/mcp`
   then `claude mcp list` and confirm `youtube ... Connected`. Tools only appear in **new** sessions.
3. **claude.ai / Desktop / Cowork:** connectors belong to the user's Claude account. If this is the same account that
   already has the connector, nothing to do. Otherwise follow section 6.

## 5. Mode B: run the server on this machine

### B1. Prerequisites

- **Node.js 22 or newer** (`node --version`) and npm. Also `git`.
- For remote use: the **ngrok** agent installed (`ngrok version`), and the user's ngrok account with a reserved
  domain. See B6.

### B2. Get the code

```bash
git clone https://github.com/umangjzx/Video-Summarizer-Youtube.git youtube-mcp-server
cd youtube-mcp-server
npm install
```

Do not copy `node_modules` from another machine. Check the clone contains `src/app.js` and `scripts/verify.mjs`; if
not, the other machine's work was never pushed. Tell the user rather than working around it.

### B3. API key (the user does this)

Tell the user: *"Create a file named `.env` in the project root containing one line,
`YOUTUBE_API_KEY=<your key>`, then tell me when it's saved. Don't paste the key here."* Optional lines: `PORT=8080`
(default). Leave `MCP_AUTH_TOKEN` unset for use with a Claude connector (see rule 5).

A key comes from console.cloud.google.com: create or pick a project, enable **YouTube Data API v3**, then
Credentials, Create credentials, API key (restrict it to that API). The same key may be copied from another machine
through a private channel, or a fresh one created.

### B4. Run the tests (no quota used, YouTube is mocked)

```bash
npm test
```

Expect `pass 58 / fail 0` (the number may grow). On **Windows, run this from PowerShell or cmd.exe**: from Git Bash
it can exit 1 with no output. That is a shell quirk, not a failing test.

### B5. Start the server and verify it locally

```bash
npm start            # listens on http://localhost:8080/mcp (PORT to change)
```

Run it in the background or a second terminal so it keeps running, then:

```bash
npm run verify -- --live
```

Expect four `PASS` lines (7 tools, quota status, overlapping requests, and a real YouTube call). A `FAIL` on the
last check with an API error means the key is wrong, the API isn't enabled, or quota is exhausted.

If the user only needs Claude Code on this machine, you can stop here and run
`claude mcp add --transport http youtube http://localhost:8080/mcp`.

### B6. Public URL for claude.ai / Desktop / Cowork (ngrok)

1. The user must be logged in to the **same ngrok account that reserved the domain**. Authenticate with
   `ngrok config add-authtoken <TOKEN>` (the user runs it; token from
   https://dashboard.ngrok.com/get-started/your-authtoken). `ngrok config check` confirms a valid config file.
2. A reserved domain can serve **one tunnel at a time**. If it is already running on another machine, stop it
   there first, or reserve a different domain (dashboard, Domains) and use that instead.
3. The default domain is set in two places: the `tunnel` script in `package.json` and `NGROK_DOMAIN` in
   `scripts/watchdog.mjs` (the watchdog also reads the `NGROK_DOMAIN` environment variable). To change domain, update
   both or set the variable.
4. With the user's go-ahead (rule 4), start the tunnel, either on its own:
   `ngrok http 8080 --url https://<domain>.ngrok-free.dev`
   or server plus tunnel with auto-restart: `npm run watch` (stop the plain `npm start` first so port 8080 is free).
   Keep that process running.
5. Verify through the public URL: `npm run verify -- https://<domain>.ngrok-free.dev`
   You can also open `http://127.0.0.1:4040` (ngrok's local inspector) to see every request Claude makes.

## 6. Connect Claude

- **Claude Code:** `claude mcp add --transport http youtube <URL>/mcp`, where `<URL>` is the localhost URL or the
  public ngrok URL. Confirm with `claude mcp list`. Start a new session to get the tools.
- **claude.ai / Desktop / Cowork (the user does this in the UI):** Settings, Connectors, Add custom connector.
  - URL must end in **`/mcp`**.
  - Leave OAuth Client ID and Secret **empty**; turn **off** "Individual sign-in" if shown.
  - If an old connector exists with a dead URL, **remove it and add a fresh one**; editing the URL did not stick.
  - Enable it for a conversation via the "+" menu, then ask Claude to run `get_quota_status` (free).
- To confirm Claude's requests really arrive, check `http://127.0.0.1:4040` for requests with user agent
  `Claude-User`. If none arrive, the problem is before your server (wrong URL or stale connector), not in the code.

## 7. Troubleshooting (all of these happened for real)

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_NGROK_3200` / "endpoint is offline" | Tunnel not running, was stopped with Ctrl+C, or a different domain | Start the tunnel and keep its window open; run tests in a *second* window |
| ngrok: "This domain is reserved for another account" | CLI authtoken belongs to a different ngrok account than the one that reserved the domain | User runs `ngrok config add-authtoken` with the right account's token, or reserves a new domain on the current account |
| ngrok status "reconnecting ... failed to fetch CRL" | Transient network error on first connect | Wait; it normally recovers on its own. Check `http://127.0.0.1:4040/api/status` for `online` |
| Connector error "Couldn't register with ...'s sign-in service" | Connector still points at an old/offline URL, or Individual sign-in is on | Remove and re-add the connector with the current URL ending in `/mcp`; no OAuth values; Individual sign-in off |
| Every connector call returns 401 | `MCP_AUTH_TOKEN` is set on the server | Unset it (Claude's connector can't send bearer tokens) |
| `claude mcp list` shows "Connected - tools fetch failed" | Server crashed or is restarting | Check server logs; run `npm run verify`. (An older version crashed when two requests overlapped; that is fixed and covered by a test) |
| Server exits at startup: `YOUTUBE_API_KEY is not set` | `.env` missing | Step B3 (the user creates it) |
| `npm test` prints nothing, exit 1 | Running npm from Git Bash on Windows | Use PowerShell or cmd.exe, or `node --test test/*.test.js` directly |
| curl with a JSON body fails on Windows `cmd` | cmd doesn't treat single quotes as quotes | Use `npm run verify` instead of hand-written curl |
| Transcripts return `available: false` (CAPTCHA / "too many requests") | Server is on a cloud/datacenter IP | Run the server from a home/office connection (this setup) |
| Claude logs show a few `400` responses, `server/discover` | Claude probes a newer protocol version than the SDK supports, then falls back | Harmless. Nothing to fix |
| Quota counter looks wrong | `.quota-usage.json` is per machine; other machines/tools using the same key aren't counted | Informational. YouTube still enforces the real 10,000/day limit |

## 8. Done checklist (report each line to the user)

- [ ] `npm test` passes (Mode B)
- [ ] `npm run verify -- --live` passes locally (Mode B)
- [ ] `npm run verify -- <public URL>` passes (if a public URL is used)
- [ ] Claude is connected: `claude mcp list` shows Connected, and/or the connector is added and
      `get_quota_status` works from a Claude conversation
- [ ] No secrets were printed, committed or pasted; nothing was pushed unless the user asked
- [ ] The user knows what must stay running: the server process, plus the ngrok tunnel if a public URL is used.
      Nothing restarts them after a reboot; a Windows Scheduled Task running `npm run watch` at log-on does that.

## 9. Command reference

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm test` | Run the test suite (no quota) |
| `npm start` | Start the server on port 8080 |
| `npm run watch` | Server + ngrok tunnel with auto-restart (logs in `logs/watchdog.log`) |
| `npm run tunnel` | Server + ngrok once, no auto-restart |
| `npm run verify -- [url] [--live]` | Health check; `--live` also makes one real YouTube call (1 unit) |
| `npm run digest -- "<topic>" --days 7 --max 100` | Batch digest CLI (costs about 200 quota units per 100 results) |
