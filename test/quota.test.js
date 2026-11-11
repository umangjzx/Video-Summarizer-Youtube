import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { useTempQuotaFile, resetQuotaFile } from "./helpers.js";

useTempQuotaFile();
const { recordUsage, getUsage, COSTS } = await import("../src/lib/quota.js");

describe("quota tracker", () => {
  beforeEach(() => resetQuotaFile());

  test("uses the real per-endpoint YouTube costs", () => {
    assert.deepEqual(COSTS, { search: 100, videos: 1, channels: 1, playlistItems: 1, captions: 50 });
  });

  test("starts at zero with the full daily limit remaining", () => {
    const u = getUsage();
    assert.equal(u.unitsUsed, 0);
    assert.equal(u.limit, 10_000);
    assert.equal(u.remaining, 10_000);
    assert.deepEqual(u.calls, {});
  });

  test("accumulates cost and per-endpoint call counts", () => {
    recordUsage("search");
    recordUsage("videos");
    recordUsage("videos");
    recordUsage("captions");
    const u = getUsage();
    assert.equal(u.unitsUsed, 100 + 1 + 1 + 50);
    assert.deepEqual(u.calls, { search: 1, videos: 2, captions: 1 });
  });

  test("charges 1 unit for an endpoint it does not know", () => {
    recordUsage("somethingNew");
    assert.equal(getUsage().unitsUsed, 1);
  });

  test("persists to disk so a restart (or the CLI) sees the same total", () => {
    recordUsage("search");
    const onDisk = JSON.parse(fs.readFileSync(process.env.QUOTA_FILE, "utf8"));
    assert.equal(onDisk.unitsUsed, 100);
  });

  test("resets when the saved quota day is not today (Pacific)", () => {
    fs.writeFileSync(
      process.env.QUOTA_FILE,
      JSON.stringify({ quotaDay: "2000-01-01", unitsUsed: 9999, calls: { search: 99 } })
    );
    const u = getUsage();
    assert.equal(u.unitsUsed, 0);
    assert.deepEqual(u.calls, {});
  });

  test("survives a corrupt usage file by starting fresh", () => {
    fs.writeFileSync(process.env.QUOTA_FILE, "{ not json");
    assert.equal(getUsage().unitsUsed, 0);
    assert.doesNotThrow(() => recordUsage("videos"));
    assert.equal(getUsage().unitsUsed, 1);
  });

  test("reports percent and remaining", () => {
    for (let i = 0; i < 25; i++) recordUsage("search");
    const u = getUsage();
    assert.equal(u.unitsUsed, 2500);
    assert.equal(u.percentUsed, 25);
    assert.equal(u.remaining, 7500);
  });

  test("warns exactly once, when usage first crosses 80%", (t) => {
    const warn = t.mock.method(console, "error", () => {});
    for (let i = 0; i < 79; i++) recordUsage("search"); // 7,900 = 79%
    assert.equal(warn.mock.callCount(), 0);
    recordUsage("search"); // 8,000 = 80%
    assert.equal(warn.mock.callCount(), 1);
    recordUsage("search"); // 8,100 — already warned
    assert.equal(warn.mock.callCount(), 1);
  });
});
