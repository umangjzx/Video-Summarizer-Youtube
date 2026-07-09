---
name: video-digest
description: Generate a digest of summaries for a batch (80-100) of YouTube videos matching a topic/query within a specific date range, using the youtube-mcp-server custom connector. Use when the user asks to summarize, analyze, or digest a set of YouTube videos over a date range or topic.
---

Requires the `youtube-mcp-server` custom connector enabled for this conversation (tools: `search_videos`, `get_video_details`, `get_transcripts_bulk`, `get_channel_uploads`, `get_quota_status`).

## Inputs to confirm before starting

If not already given, ask the user for:
- **Query/topic** — the search keywords.
- **Date range** — `publishedAfter` / `publishedBefore` (ISO 8601).
- **Target count** — default 100 if unspecified.
- **Sort preference** — `date` (chronological coverage) vs `viewCount`/`relevance` (biggest/most relevant videos only). Default `date` for a comprehensive digest.
- **Output format** — chat/markdown (default), an Artifact (interactive, if that tool is available), or a PDF file. Ask if not stated; don't assume.

**If the query looks like a public company name or stock ticker**, warn the user up front: YouTube search results for
any public company are typically dominated by AI-generated "stock analysis" content-mill channels that publish
near-daily videos for every ticker (confirmed pattern — searching "KLA corporation" returned ~65% stock/finance
videos out of a genuinely mixed pool that also included hiring posts, product content, and unrelated brand-name
collisions). This isn't a search bug — it's the real composition of what's published. If the user wants broader
company coverage rather than a finance-skewed digest, suggest narrowing the query (e.g. "KLA Corporation careers" or
"KLA Corporation semiconductor technology" instead of the bare company name) or explicitly asking to exclude
stock/trading content.

## Workflow

1. **Check quota, then search once.** For a run near/above 50 videos, call `get_quota_status` first — a 100-video search costs ~200 of the 10,000 daily units. If usage is already high, tell the user before proceeding rather than letting the search fail partway. Then call `search_videos` with `maxResults` up to 100 for the query + date range — don't repeat this call for the same query/range.

2. **Optional: enrich with stats.** If the user cares about popularity/engagement, batch the returned video IDs through `get_video_details` in chunks of 50 to get view/like counts and duration. Use this to filter out low-signal videos (e.g. very low views) or Shorts if the user only wants long-form content.

3. **Fetch transcripts in batches.** This connector runs through a tunnel to a residential IP (not a cloud host), so transcript fetching generally works well — expect most videos to return real transcript text, with occasional legitimate failures (captions genuinely disabled/unavailable for that video, not a block). Process video IDs in batches of ~10-15 via `get_transcripts_bulk`:
   - For each video with `available: true`, write a 2-4 sentence summary grounded in the actual transcript content plus title/channel context.
   - For each video with `available: false`, write a 1-sentence summary from title + description only, and note "(no transcript available)".
   - Summarize each batch before moving to the next batch — don't hold all 80-100 transcripts in context simultaneously.
   - If an entire batch comes back `available: false` (unusual), that may mean the tunnel/local server isn't running right now — mention this to the user rather than silently treating it as normal.

4. **Categorize before compiling.** Tag each video into a rough category as you summarize it — e.g. `stock/finance analysis`, `hiring/jobs`, `product/technical`, `unrelated match` (title/channel shares the search term by coincidence, not actually about the topic), `other`. This is what makes a finance-skewed result set (see above) legible instead of surprising — lead the digest with a one-line composition breakdown, e.g. "62 stock-analysis videos, 12 hiring posts, 8 product/technical, 5 unrelated matches, 13 other."

5. **Compile the digest**, grouped by category (most numerous category first, unless the user asked for a different order — chronological, by channel, by view count). Each entry:
   - Title (linked: `https://youtube.com/watch?v=<videoId>`)
   - Channel
   - Published date
   - View count (if fetched)
   - Summary
   - Category tag

6. **Deliver in the requested format:**
   - **Chat/markdown** (default): write the categorized breakdown + entries directly in the response.
   - **Artifact**: same content, as an interactive/filterable page if the Artifact tool is available in this environment.
   - **PDF**: if a PDF-creation capability is available in this environment (e.g. the `pdf` skill), use it to render the compiled digest (title, composition breakdown, entries) into an actual PDF file. If running the *local* CLI pipeline instead of through Cowork, use `node scripts/render-pdf.mjs <report.json> <summaries.json> [out.pdf]` from the youtube-mcp-server repo — write the per-video summaries as a `{"<videoId>": "summary text"}` JSON map first, matching what you produced in step 3.

7. **Report gaps.** State how many of the target videos actually had transcripts available vs. metadata-only summaries, so the user knows the digest's depth isn't uniform.

## Notes

- Transcript fetching is unofficial (YouTube's public caption endpoint, not the Data API) — expect some failures and don't be surprised if it needs fixing later if YouTube changes its page structure.
- Respect the search quota: the dedicated search bucket is roughly 100 calls/day. A single 100-result search uses ~2 of those: don't re-run searches speculatively.
- This connector only works while the user's local server + tunnel (`npm run watch`, or `npm run tunnel`) are running. If every tool call fails or times out, tell the user to check that rather than retrying repeatedly.
- Video titles/descriptions from these tools are already HTML-entity-decoded (no literal `&amp;` etc.) — don't re-decode or second-guess odd-looking text unless it's genuinely garbled.
