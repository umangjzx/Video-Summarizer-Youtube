import { YoutubeTranscript } from "youtube-transcript";

// Fetches a transcript via YouTube's public caption endpoint (no OAuth/API key).
// This is NOT part of the official Data API and can break if YouTube changes its
// page structure, or fail for videos with captions disabled/unavailable. It also
// gets CAPTCHA-blocked reliably from shared cloud/datacenter IPs (Railway, Render,
// etc.) — this only works well from a residential connection. See README.
export async function fetchTranscriptText(videoId, lang, maxChars) {
  const segments = await YoutubeTranscript.fetchTranscript(videoId, lang ? { lang } : undefined);
  let text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  const truncated = maxChars && text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return {
    segmentCount: segments.length,
    language: segments[0]?.lang || lang || null,
    transcript: text,
    truncated: Boolean(truncated),
  };
}

// Fetches transcripts for many videos sequentially with a jittered delay between
// each request, rather than in parallel — firing everything at once from a single
// IP is exactly the burst pattern that trips anti-bot rate limiting. Per-video
// failures are returned inline; a failure never aborts the whole batch.
export async function fetchTranscriptsSequential(videoIds, { lang, maxChars, minDelayMs = 400, maxDelayMs = 800, onProgress } = {}) {
  const results = [];
  for (let i = 0; i < videoIds.length; i++) {
    if (i > 0) {
      const delayMs = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const videoId = videoIds[i];
    try {
      const result = await fetchTranscriptText(videoId, lang, maxChars);
      results.push({ videoId, available: true, ...result });
    } catch (e) {
      results.push({ videoId, available: false, error: e.message });
    }
    onProgress?.(i + 1, videoIds.length, results[results.length - 1]);
  }
  return results;
}
