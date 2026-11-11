import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { YoutubeTranscript } from "youtube-transcript";
import { fetchTranscriptText, fetchTranscriptsSequential, pickFallbackLanguage } from "../src/lib/transcripts.js";

const original = YoutubeTranscript.fetchTranscript;
afterEach(() => {
  YoutubeTranscript.fetchTranscript = original;
});

const seg = (text, lang = "en") => ({ text, lang, offset: 0, duration: 1 });

describe("fetchTranscriptText", () => {
  test("joins segments, collapses whitespace and reports counts", async () => {
    YoutubeTranscript.fetchTranscript = async () => [seg("hello   there"), seg("\nworld  "), seg("again")];
    const r = await fetchTranscriptText("vid1");
    assert.equal(r.transcript, "hello there world again");
    assert.equal(r.segmentCount, 3);
    assert.equal(r.language, "en");
    assert.equal(r.truncated, false);
  });

  test("truncates to maxChars and says so", async () => {
    YoutubeTranscript.fetchTranscript = async () => [seg("a".repeat(1000))];
    const r = await fetchTranscriptText("vid1", undefined, 600);
    assert.equal(r.transcript.length, 600);
    assert.equal(r.truncated, true);
  });

  test("does not flag truncation when the text already fits", async () => {
    YoutubeTranscript.fetchTranscript = async () => [seg("short")];
    const r = await fetchTranscriptText("vid1", undefined, 5000);
    assert.equal(r.truncated, false);
  });

  test("asks for English by default and passes an explicit language through", async () => {
    const seen = [];
    YoutubeTranscript.fetchTranscript = async (id, opts) => {
      seen.push(opts);
      return [seg("x", opts.lang)];
    };
    await fetchTranscriptText("vid1", "fr");
    await fetchTranscriptText("vid1");
    assert.deepEqual(seen, [{ lang: "fr" }, { lang: "en" }]);
  });

  test("propagates fetch failures (callers decide how to report them)", async () => {
    YoutubeTranscript.fetchTranscript = async () => {
      throw new Error("Transcript is disabled on this video");
    };
    await assert.rejects(() => fetchTranscriptText("vid1"), /disabled/);
  });
});

// What the youtube-transcript library throws when the exact language code is missing.
const noLang = (asked, available, id = "vid1") =>
  new Error(`[YoutubeTranscript] 🚨 No transcripts are available in ${asked} this video (${id}). Available languages: ${available.join(", ")}`);

// A fake video that has captions only in `tracks` (exact-match on language code, like the real library).
function videoWithTracks(tracks) {
  const asked = [];
  YoutubeTranscript.fetchTranscript = async (id, opts) => {
    asked.push(opts.lang);
    if (!tracks.includes(opts.lang)) throw noLang(opts.lang, tracks, id);
    return [seg(`text in ${opts.lang}`, opts.lang)];
  };
  return asked;
}

describe("language handling (English first, translate otherwise)", () => {
  test("an en-US track satisfies a request for English (the CNN case)", async () => {
    const asked = videoWithTracks(["en-US"]);
    const r = await fetchTranscriptText("vid1");
    assert.deepEqual(asked, ["en", "en-US"]);
    assert.equal(r.language, "en-US");
    assert.equal(r.needsTranslation, false);
    assert.equal("note" in r, false);
    assert.equal(r.transcript, "text in en-US");
  });

  test("a video with only Vietnamese captions comes back flagged for translation", async () => {
    videoWithTracks(["vi"]);
    const r = await fetchTranscriptText("vid1");
    assert.equal(r.language, "vi");
    assert.equal(r.requestedLanguage, "en");
    assert.equal(r.needsTranslation, true);
    assert.match(r.note, /no English captions/);
    assert.match(r.note, /"vi"/);
    assert.match(r.note, /Translate it into English/);
    assert.equal(r.transcript, "text in vi");
  });

  test("prefers an English track over the first listed one", async () => {
    const asked = videoWithTracks(["vi", "en-GB", "fr"]);
    const r = await fetchTranscriptText("vid1");
    assert.deepEqual(asked, ["en", "en-GB"]);
    assert.equal(r.needsTranslation, false);
  });

  test("an exact English track needs only one request", async () => {
    const asked = videoWithTracks(["en", "vi"]);
    const r = await fetchTranscriptText("vid1");
    assert.deepEqual(asked, ["en"]);
    assert.equal(r.needsTranslation, false);
  });

  test("a language the user explicitly asked for is not flagged for translation", async () => {
    videoWithTracks(["fr", "en"]);
    const r = await fetchTranscriptText("vid1", "fr");
    assert.equal(r.language, "fr");
    assert.equal(r.needsTranslation, false);
  });

  test("falls back to English when an explicitly requested language is missing", async () => {
    videoWithTracks(["en", "vi"]);
    const r = await fetchTranscriptText("vid1", "de");
    assert.equal(r.language, "en");
    assert.equal(r.needsTranslation, false);
  });

  test("errors that are not about language are not retried", async () => {
    let calls = 0;
    YoutubeTranscript.fetchTranscript = async () => {
      calls++;
      throw new Error("[YoutubeTranscript] 🚨 Transcript is disabled on this video (vid1)");
    };
    await assert.rejects(() => fetchTranscriptText("vid1"), /disabled/);
    assert.equal(calls, 1);
  });

  test("truncation still applies to a translated-language transcript", async () => {
    YoutubeTranscript.fetchTranscript = async (id, opts) => {
      if (opts.lang === "en") throw noLang("en", ["vi"]);
      return [seg("x".repeat(1000), "vi")];
    };
    const r = await fetchTranscriptText("vid1", undefined, 600);
    assert.equal(r.transcript.length, 600);
    assert.equal(r.truncated, true);
    assert.equal(r.needsTranslation, true);
  });

  test("bulk fetching applies the same fallback to every video", async () => {
    YoutubeTranscript.fetchTranscript = async (id, opts) => {
      const tracks = { a: ["en"], b: ["en-US"], c: ["vi"] }[id];
      if (!tracks.includes(opts.lang)) throw noLang(opts.lang, tracks, id);
      return [seg(`t-${id}`, opts.lang)];
    };
    const results = await fetchTranscriptsSequential(["a", "b", "c"], { minDelayMs: 0, maxDelayMs: 1 });
    assert.deepEqual(results.map((r) => [r.videoId, r.language, r.needsTranslation]), [
      ["a", "en", false],
      ["b", "en-US", false],
      ["c", "vi", true],
    ]);
  });
});

describe("pickFallbackLanguage", () => {
  test("prefers the requested language or a regional variant of it", () => {
    assert.equal(pickFallbackLanguage(["vi", "en-GB"], "en"), "en-GB");
    assert.equal(pickFallbackLanguage(["en", "pt-BR"], "pt"), "pt-BR");
  });
  test("then any English track, then whatever exists", () => {
    assert.equal(pickFallbackLanguage(["vi", "en-US"], "de"), "en-US");
    assert.equal(pickFallbackLanguage(["vi", "fr"], "de"), "vi");
  });
});

describe("fetchTranscriptsSequential", () => {
  const fast = { minDelayMs: 0, maxDelayMs: 1 };

  test("returns results in input order and keeps going past a failure", async () => {
    YoutubeTranscript.fetchTranscript = async (id) => {
      if (id === "bad") throw new Error("captions disabled");
      return [seg(`text for ${id}`)];
    };
    const results = await fetchTranscriptsSequential(["a", "bad", "c"], fast);
    assert.deepEqual(
      results.map((r) => [r.videoId, r.available]),
      [["a", true], ["bad", false], ["c", true]]
    );
    assert.equal(results[1].error, "captions disabled");
    assert.equal(results[2].transcript, "text for c");
  });

  test("fetches one at a time, never in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    YoutubeTranscript.fetchTranscript = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [seg("x")];
    };
    await fetchTranscriptsSequential(["a", "b", "c", "d"], fast);
    assert.equal(maxInFlight, 1);
  });

  test("reports progress after every video", async () => {
    YoutubeTranscript.fetchTranscript = async () => [seg("x")];
    const progress = [];
    await fetchTranscriptsSequential(["a", "b"], { ...fast, onProgress: (done, total) => progress.push([done, total]) });
    assert.deepEqual(progress, [[1, 2], [2, 2]]);
  });
});
