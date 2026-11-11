import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { YoutubeTranscript } from "youtube-transcript";
import { fetchTranscriptText, fetchTranscriptsSequential } from "../src/lib/transcripts.js";

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

  test("passes the preferred language through, and nothing when unset", async () => {
    const seen = [];
    YoutubeTranscript.fetchTranscript = async (id, opts) => {
      seen.push(opts);
      return [seg("x")];
    };
    await fetchTranscriptText("vid1", "fr");
    await fetchTranscriptText("vid1");
    assert.deepEqual(seen, [{ lang: "fr" }, undefined]);
  });

  test("propagates fetch failures (callers decide how to report them)", async () => {
    YoutubeTranscript.fetchTranscript = async () => {
      throw new Error("Transcript is disabled on this video");
    };
    await assert.rejects(() => fetchTranscriptText("vid1"), /disabled/);
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
