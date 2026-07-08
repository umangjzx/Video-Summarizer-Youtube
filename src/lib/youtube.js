const YT_BASE = "https://www.googleapis.com/youtube/v3";

export async function ytFetch(apiKey, path, params) {
  const url = new URL(`${YT_BASE}/${path}`);
  url.searchParams.set("key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok) {
    const reason = data?.error?.message || res.statusText;
    throw new Error(`YouTube API error (${res.status}): ${reason}`);
  }
  return data;
}

export function isoDuration(pt) {
  // Convert ISO 8601 duration (e.g. PT4M13S) to seconds, roughly.
  const m = pt?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const s = parseInt(m[3] || "0", 10);
  return h * 3600 + min * 60 + s;
}

export async function searchVideos(apiKey, { query, publishedAfter, publishedBefore, order, maxResults, pageToken }) {
  const target = maxResults || 25;
  const items = [];
  let nextPageToken = pageToken;
  let totalResultsEstimate;
  let searchUnitsUsed = 0;

  do {
    const data = await ytFetch(apiKey, "search", {
      part: "snippet",
      q: query,
      type: "video",
      order: order || "relevance",
      maxResults: Math.min(50, target - items.length),
      publishedAfter,
      publishedBefore,
      pageToken: nextPageToken,
    });
    searchUnitsUsed++;
    totalResultsEstimate = data.pageInfo?.totalResults;
    nextPageToken = data.nextPageToken || null;

    for (const it of data.items || []) {
      items.push({
        videoId: it.id.videoId,
        title: it.snippet.title,
        channelTitle: it.snippet.channelTitle,
        channelId: it.snippet.channelId,
        publishedAt: it.snippet.publishedAt,
        description: it.snippet.description,
      });
    }
  } while (items.length < target && nextPageToken);

  return { items, nextPageToken, totalResultsEstimate, searchUnitsUsed };
}

export async function getVideoDetails(apiKey, videoIds) {
  const data = await ytFetch(apiKey, "videos", {
    part: "snippet,statistics,contentDetails",
    id: videoIds.join(","),
  });

  return (data.items || []).map((it) => {
    const seconds = isoDuration(it.contentDetails?.duration);
    return {
      videoId: it.id,
      title: it.snippet?.title,
      channelTitle: it.snippet?.channelTitle,
      publishedAt: it.snippet?.publishedAt,
      viewCount: it.statistics?.viewCount ? Number(it.statistics.viewCount) : null,
      likeCount: it.statistics?.likeCount ? Number(it.statistics.likeCount) : null,
      commentCount: it.statistics?.commentCount ? Number(it.statistics.commentCount) : null,
      durationSeconds: seconds,
      isShort: seconds !== null ? seconds < 180 : null,
    };
  });
}

// Batches video IDs into chunks of 50 (the API's per-call limit) and fetches details for all of them.
export async function getVideoDetailsBulk(apiKey, videoIds) {
  const results = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    results.push(...(await getVideoDetails(apiKey, chunk)));
  }
  return results;
}

export async function getChannelUploads(apiKey, { channelId, maxResults, pageToken }) {
  const chData = await ytFetch(apiKey, "channels", { part: "contentDetails", id: channelId });
  const uploadsPlaylistId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    return { error: "Channel not found or has no uploads playlist.", items: [] };
  }

  const plData = await ytFetch(apiKey, "playlistItems", {
    part: "snippet,contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: maxResults || 25,
    pageToken,
  });

  const items = (plData.items || []).map((it) => ({
    videoId: it.contentDetails?.videoId,
    title: it.snippet?.title,
    publishedAt: it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt,
  }));

  return { nextPageToken: plData.nextPageToken || null, items };
}

export async function listCaptions(apiKey, videoId) {
  const data = await ytFetch(apiKey, "captions", { part: "snippet", videoId });
  return (data.items || []).map((it) => ({
    language: it.snippet?.language,
    trackKind: it.snippet?.trackKind,
    isAutoSynced: it.snippet?.trackKind === "asr",
  }));
}
