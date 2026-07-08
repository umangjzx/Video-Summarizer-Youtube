import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUOTA_FILE = join(__dirname, "..", "..", ".quota-usage.json");

// Real per-endpoint costs from the YouTube Data API v3 docs — search.list is
// far more expensive than everything else, which is why search results are
// capped/paginated carefully elsewhere in this codebase.
const COSTS = { search: 100, videos: 1, channels: 1, playlistItems: 1, captions: 50 };
const DAILY_LIMIT = 10_000;
const WARN_THRESHOLD = 0.8;

// YouTube's quota resets at midnight Pacific Time, not local midnight —
// tracking against the wrong day boundary would make usage look wrong for
// anyone not in Pacific Time.
function currentQuotaDay() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
    if (raw.quotaDay === currentQuotaDay()) return raw;
  } catch {
    // Missing or corrupt file — start fresh below.
  }
  return { quotaDay: currentQuotaDay(), unitsUsed: 0, calls: {} };
}

function writeState(state) {
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("WARN: failed to persist quota usage:", e.message);
  }
}

export function recordUsage(endpoint) {
  const cost = COSTS[endpoint] ?? 1;
  const state = readState();
  const before = state.unitsUsed;
  state.unitsUsed += cost;
  state.calls[endpoint] = (state.calls[endpoint] || 0) + 1;
  writeState(state);

  const pctBefore = before / DAILY_LIMIT;
  const pctAfter = state.unitsUsed / DAILY_LIMIT;
  if (pctAfter >= WARN_THRESHOLD && pctBefore < WARN_THRESHOLD) {
    console.error(
      `WARN: YouTube API quota at ${Math.round(pctAfter * 100)}% (${state.unitsUsed}/${DAILY_LIMIT}) for ${state.quotaDay} (Pacific Time).`
    );
  }
  return state;
}

export function getUsage() {
  const state = readState();
  return {
    quotaDay: state.quotaDay,
    unitsUsed: state.unitsUsed,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - state.unitsUsed),
    percentUsed: Math.round((state.unitsUsed / DAILY_LIMIT) * 100),
    calls: state.calls,
  };
}
