#!/usr/bin/env node
// Renders a digest.mjs report JSON (+ optional summaries) into the styled,
// filterable HTML digest artifact. Usage:
//
//   node scripts/render-digest.mjs <report.json> [summaries.json] [out.html]
//
// summaries.json is a flat { "<videoId>": "one or two sentence summary" } map
// — write the actual summary text yourself (or have Claude write it after
// reading the transcripts in report.json), this script only handles the
// mechanical merge + render. Without it, falls back to a truncated
// description so the artifact is still usable for a quick look.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const [, , reportPath, summariesPath, outPathArg] = process.argv;

if (!reportPath) {
  console.error('Usage: node scripts/render-digest.mjs <report.json> [summaries.json] [out.html]');
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const summaries = summariesPath ? JSON.parse(readFileSync(summariesPath, "utf8")) : {};

function fallbackSummary(video) {
  const desc = (video.description || "").trim();
  if (!desc) return "(no summary available)";
  return desc.length > 160 ? desc.slice(0, 157) + "..." : desc;
}

const data = report.videos.map((v) => ({
  id: v.videoId,
  title: v.title,
  channel: v.channelTitle,
  published: v.publishedAt,
  views: v.viewCount,
  isShort: v.isShort,
  duration: v.durationSeconds,
  hasTranscript: Boolean(v.transcriptAvailable),
  summary: summaries[v.videoId] || fallbackSummary(v),
}));

const withTranscript = data.filter((d) => d.hasTranscript).length;
const dateRange = `${new Date(report.publishedAfter).toLocaleDateString()}–${new Date(report.publishedBefore).toLocaleDateString()}`;
const usingFallback = Object.keys(summaries).length === 0;

const template = readFileSync(join(__dirname, "templates", "digest.template.html"), "utf8");

const html = template
  .replace("__TITLE__", `${report.query} — video digest`)
  .replace("__KICKER__", `Video digest · generated ${new Date(report.generatedAt).toLocaleString()}`)
  .replace("__HEADLINE__", report.query)
  .replace(
    "__DEK__",
    `${data.length} videos matching “${report.query}”, published ${dateRange}. ` +
      `${withTranscript}/${data.length} (${data.length ? Math.round((withTranscript / data.length) * 100) : 0}%) have real transcripts.` +
      (usingFallback ? " No summaries.json provided — showing truncated descriptions instead of written summaries." : "")
  )
  .replace("__SOURCE_LINE__", "youtube-mcp-server · scripts/digest.mjs + scripts/render-digest.mjs")
  .replace("__DATA_JSON__", JSON.stringify(data));

const outPath = outPathArg || reportPath.replace(/\.json$/, ".html");
writeFileSync(outPath, html);
console.error(`Wrote ${outPath} (${data.length} videos, ${withTranscript} with transcripts)`);
