#!/usr/bin/env node
// Standalone digest builder: search YouTube for a query/date range, enrich with
// stats, and fetch transcripts — all from whatever machine runs this script.
// Run this locally (not on the Railway deployment) since transcript fetching
// gets CAPTCHA-blocked reliably from shared cloud IPs. See README.
//
// Usage:
//   node scripts/digest.mjs "AI stock market analysis" --days 7 --max 100
//   node scripts/digest.mjs "topic" --after 2026-07-01T00:00:00Z --before 2026-07-08T00:00:00Z --out report.json
//
// Output is a single JSON file: an array of videos with metadata + transcript
// (where available). Writing the actual digest/summaries from that report is a
// separate step — hand the file to Claude, or write your own summarizer.

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { requireApiKey } from "../src/lib/env.js";
import { searchVideos, getVideoDetailsBulk } from "../src/lib/youtube.js";
import { fetchTranscriptsSequential } from "../src/lib/transcripts.js";
import { getUsage } from "../src/lib/quota.js";

function usage() {
  console.error(`Usage: node scripts/digest.mjs "<query>" [options]

Options:
  --days <n>          Look back this many days from now (default: 7). Ignored if --after/--before given.
  --after <iso>        Explicit publishedAfter, e.g. 2026-07-01T00:00:00Z
  --before <iso>        Explicit publishedBefore
  --max <n>            Max videos to fetch (default: 100, costs ~1 search unit per 50)
  --order <mode>        relevance | date | viewCount | rating (default: date)
  --lang <code>         Preferred transcript language, e.g. en
  --max-chars <n>        Truncate each transcript to this many characters (default: 20000)
  --skip-details         Skip the get_video_details enrichment step (views/likes/duration)
  --skip-transcripts       Skip transcript fetching entirely (metadata-only report)
  --out <path>          Output file (default: digest-<slug>-<date>.json)
`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: "string", default: "7" },
    after: { type: "string" },
    before: { type: "string" },
    max: { type: "string", default: "100" },
    order: { type: "string", default: "date" },
    lang: { type: "string" },
    "max-chars": { type: "string", default: "20000" },
    "skip-details": { type: "boolean", default: false },
    "skip-transcripts": { type: "boolean", default: false },
    out: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help || positionals.length === 0) {
  usage();
  process.exit(values.help ? 0 : 1);
}

const query = positionals.join(" ");
const apiKey = requireApiKey();

const now = new Date();
const publishedBefore = values.before || now.toISOString();
const publishedAfter = values.after || new Date(now.getTime() - Number(values.days) * 86400000).toISOString();

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

async function main() {
  console.error(`Searching "${query}" from ${publishedAfter} to ${publishedBefore} (max ${values.max}, order ${values.order})...`);
  const search = await searchVideos(apiKey, {
    query,
    publishedAfter,
    publishedBefore,
    order: values.order,
    maxResults: Number(values.max),
  });

  const seen = new Set();
  const items = search.items.filter((it) => (seen.has(it.videoId) ? false : seen.add(it.videoId)));
  console.error(`Found ${items.length} unique videos (${search.searchUnitsUsed} search units used).`);

  let statsById = {};
  if (!values["skip-details"]) {
    console.error(`Fetching stats for ${items.length} videos...`);
    const details = await getVideoDetailsBulk(apiKey, items.map((it) => it.videoId));
    statsById = Object.fromEntries(details.map((d) => [d.videoId, d]));
  }

  let transcriptById = {};
  if (!values["skip-transcripts"]) {
    console.error(`Fetching transcripts for ${items.length} videos (sequential, jittered — this takes a while)...`);
    const maxChars = Number(values["max-chars"]);
    const results = await fetchTranscriptsSequential(
      items.map((it) => it.videoId),
      {
        lang: values.lang,
        maxChars,
        onProgress: (done, total, last) => {
          const status = last.available ? "ok" : "unavailable";
          if (done % 10 === 0 || done === total) {
            console.error(`  transcripts: ${done}/${total} (last: ${status})`);
          }
        },
      }
    );
    transcriptById = Object.fromEntries(results.map((r) => [r.videoId, r]));
  }

  const report = items.map((it) => {
    const stats = statsById[it.videoId];
    const transcript = transcriptById[it.videoId];
    return {
      videoId: it.videoId,
      title: it.title,
      channelTitle: it.channelTitle,
      channelId: it.channelId,
      publishedAt: it.publishedAt,
      description: it.description,
      viewCount: stats?.viewCount ?? null,
      likeCount: stats?.likeCount ?? null,
      commentCount: stats?.commentCount ?? null,
      durationSeconds: stats?.durationSeconds ?? null,
      isShort: stats?.isShort ?? null,
      transcriptAvailable: transcript?.available ?? null,
      transcript: transcript?.available ? transcript.transcript : null,
      transcriptError: transcript && !transcript.available ? transcript.error : null,
    };
  });

  const withTranscript = report.filter((r) => r.transcriptAvailable).length;
  const outPath = values.out || `digest-${slugify(query)}-${now.toISOString().slice(0, 10)}.json`;
  writeFileSync(outPath, JSON.stringify({ query, publishedAfter, publishedBefore, generatedAt: now.toISOString(), videos: report }, null, 2));

  console.error(`\nWrote ${report.length} videos to ${outPath}`);
  if (!values["skip-transcripts"]) {
    console.error(`Transcripts available: ${withTranscript}/${report.length} (${Math.round((withTranscript / report.length) * 100)}%)`);
  }

  const quota = getUsage();
  console.error(`YouTube API quota today (${quota.quotaDay}, Pacific Time): ${quota.unitsUsed}/${quota.limit} used (${quota.percentUsed}%), ${quota.remaining} remaining.`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
