---
name: video-digest
description: Generate a digest of summaries for a batch (80-100) of YouTube videos matching a topic/query within a specific date range, using the youtube-mcp-server custom connector. Use when the user asks to summarize, analyze, or digest a set of YouTube videos over a date range or topic.
---

Requires the `youtube-mcp-server` custom connector enabled for this conversation (tools: `search_videos`, `get_video_details`, `get_transcripts_bulk`, `get_channel_uploads`).

## Inputs to confirm before starting

If not already given, ask the user for:
- **Query/topic** — the search keywords.
- **Date range** — `publishedAfter` / `publishedBefore` (ISO 8601).
- **Target count** — default 100 if unspecified.
- **Sort preference** — `date` (chronological coverage) vs `viewCount`/`relevance` (biggest/most relevant videos only). Default `date` for a comprehensive digest.

## Workflow

1. **Search once.** Call `search_videos` with `maxResults` up to 100 for the query + date range. This costs ~2 search units per 100 results — don't repeat this call for the same query/range.

2. **Optional: enrich with stats.** If the user cares about popularity/engagement, batch the returned video IDs through `get_video_details` in chunks of 50 to get view/like counts and duration. Use this to filter out low-signal videos (e.g. very low views) or Shorts if the user only wants long-form content.

3. **Fetch transcripts in batches, but expect most to fail.** When this connector is deployed on a cloud host (Railway/Render/etc.), YouTube's anti-bot system blocks the vast majority of transcript requests with a CAPTCHA error — confirmed in testing: real videos failed almost every time, throttling didn't fix it. Treat transcript fetching as a bonus, not the primary path. Process video IDs in batches of ~10-15 via `get_transcripts_bulk`:
   - For each video with `available: true` (will be a minority when running remotely), write a 2-4 sentence summary grounded in the actual transcript content plus title/channel context.
   - For each video with `available: false` — whether from captions being disabled/missing OR from the CAPTCHA block — write a 1-sentence summary from title + description only, and note "(no transcript available)". Don't distinguish the reason to the end user unless asked; both look the same from the caller's side.
   - Summarize each batch before moving to the next batch — don't hold all 80-100 transcripts in context simultaneously.
   - Set expectations with the user upfront if most/all of a batch comes back `available: false`: this is a known limitation of running transcript fetching from a cloud IP, not a bug to retry around.

4. **Compile the digest.** Produce a single deliverable (markdown, or an Artifact if that tool is available) with one row/entry per video:
   - Title (linked: `https://youtube.com/watch?v=<videoId>`)
   - Channel
   - Published date
   - View count (if fetched)
   - Summary
   
   Group or sort however is most useful for the request (chronological, by channel, by view count).

5. **Report gaps.** State how many of the target videos actually had transcripts available vs. metadata-only summaries, so the user knows the digest's depth isn't uniform.

## Notes

- Transcript fetching is unofficial (YouTube's public caption endpoint, not the Data API) — expect some failures and don't be surprised if it needs fixing later if YouTube changes its page structure.
- Respect the search quota: the dedicated search bucket is roughly 100 calls/day. A single 100-result search uses ~2 of those: don't re-run searches speculatively.
- On a cloud deployment, expect the digest to realistically be **metadata-only** (title/channel/description/stats) for nearly all videos, with transcript-depth summaries as an occasional bonus rather than the norm. Don't promise transcript-based analysis to the user upfront — undersell then overdeliver on the rare video that does have a fetchable transcript.
