#!/usr/bin/env node
// Renders a digest.mjs report JSON (+ optional summaries) into a PDF report,
// for when you want a file to save/share rather than an interactive page.
// Usage:
//
//   node scripts/render-pdf.mjs <report.json> [summaries.json] [out.pdf]
//
// Same inputs as render-digest.mjs (the HTML version) — this is the
// print/share-friendly sibling, not a replacement.

import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";
import fs from "node:fs";

const [, , reportPath, summariesPath, outPathArg] = process.argv;

if (!reportPath) {
  console.error("Usage: node scripts/render-pdf.mjs <report.json> [summaries.json] [out.pdf]");
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const summaries = summariesPath ? JSON.parse(readFileSync(summariesPath, "utf8")) : {};

function fallbackSummary(video) {
  const desc = (video.description || "").trim();
  if (!desc) return "(no summary available)";
  return desc.length > 200 ? desc.slice(0, 197) + "..." : desc;
}

function fmtViews(n) {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const videos = report.videos.map((v) => ({
  ...v,
  summary: summaries[v.videoId] || fallbackSummary(v),
  hasTranscript: Boolean(v.transcriptAvailable),
}));

const withTranscript = videos.filter((v) => v.hasTranscript).length;
const outPath = outPathArg || reportPath.replace(/\.json$/, ".pdf");

const doc = new PDFDocument({ size: "A4", margin: 56, bufferPages: true });
doc.pipe(fs.createWriteStream(outPath));

// ---- Header ----
doc.font("Helvetica-Bold").fontSize(20).text(report.query, { align: "left" });
doc.moveDown(0.3);
doc
  .font("Helvetica")
  .fontSize(10)
  .fillColor("#555555")
  .text(
    `${videos.length} videos · ${fmtDate(report.publishedAfter)} – ${fmtDate(report.publishedBefore)} · ` +
      `${withTranscript}/${videos.length} with real transcripts (${videos.length ? Math.round((withTranscript / videos.length) * 100) : 0}%) · ` +
      `generated ${fmtDate(report.generatedAt)}`
  );
doc.fillColor("#000000");
doc.moveDown(1);
doc
  .moveTo(doc.x, doc.y)
  .lineTo(doc.page.width - doc.page.margins.right, doc.y)
  .strokeColor("#cccccc")
  .stroke();
doc.moveDown(1);

// ---- Entries ----
for (const v of videos) {
  if (doc.y > doc.page.height - doc.page.margins.bottom - 90) doc.addPage();

  doc.font("Helvetica-Bold").fontSize(12).fillColor("#000000").text(v.title, { link: `https://youtube.com/watch?v=${v.videoId}`, underline: false });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#777777")
    .text(`${v.channelTitle} · ${fmtDate(v.publishedAt)} · ${fmtViews(v.viewCount)} views${v.isShort ? " · Short" : ""}${v.hasTranscript ? " · transcript" : " · meta only"}`);
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10.5).fillColor("#222222").text(v.summary, { align: "left" });
  doc.fillColor("#000000");
  doc.moveDown(0.9);
}

// ---- Page numbers ----
const range = doc.bufferedPageRange();
for (let i = range.start; i < range.start + range.count; i++) {
  doc.switchToPage(i);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#999999")
    .text(`${i + 1} / ${range.count}`, 0, doc.page.height - 40, { align: "center", width: doc.page.width });
}

doc.end();
doc.on("end", () => {
  console.error(`Wrote ${outPath} (${videos.length} videos, ${withTranscript} with transcripts)`);
});
