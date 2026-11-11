import { YoutubeTranscript } from "youtube-transcript";

// Fetches a transcript via YouTube's public caption endpoint (no OAuth/API key).
// This is NOT part of the official Data API and can break if YouTube changes its
// page structure, or fail for videos with captions disabled/unavailable. It also
// gets CAPTCHA-blocked reliably from shared cloud/datacenter IPs (Railway, Render,
// etc.) — this only works well from a residential connection. See README.
//
// Language handling: English is always preferred. The underlying library only matches
// the language code EXACTLY, so asking for "en" fails on a video whose track is "en-US"
// or "en-GB", and a video with only (say) Vietnamese captions fails outright. Both are
// handled here by reading the list of available tracks out of the library's error and
// retrying with the best one: the requested language or a regional variant of it, then
// any English track, then whatever exists. When we wanted English but could only get
// another language, the result says so (needsTranslation + note) so the calling Claude
// translates it, rather than the video just being reported as unavailable.
const isEnglish = (code) => /^en(-|$)/i.test(code || "");

function availableLanguagesFrom(err) {
  const m = /Available languages:\s*(.+)$/i.exec(err?.message || "");
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export function pickFallbackLanguage(available, preferred = "en") {
  const base = preferred.toLowerCase().split("-")[0];
  return (
    available.find((l) => l.toLowerCase().split("-")[0] === base) ||
    available.find(isEnglish) ||
    available[0]
  );
}

export async function fetchTranscriptText(videoId, lang, maxChars) {
  const requested = lang || "en";
  let used = requested;
  let segments;
  try {
    segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: requested });
  } catch (e) {
    const available = availableLanguagesFrom(e);
    if (available.length === 0) throw e; // disabled / unavailable / rate-limited: not a language problem
    used = pickFallbackLanguage(available, requested);
    segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: used });
  }

  let text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  const truncated = maxChars && text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  const language = segments[0]?.lang || used;
  const needsTranslation = isEnglish(requested) && !isEnglish(language);
  return {
    segmentCount: segments.length,
    language,
    requestedLanguage: requested,
    needsTranslation,
    ...(needsTranslation && {
      note: `This video has no English captions; the text below is in "${language}". Translate it into English before summarizing, quoting or answering from it.`,
    }),
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
