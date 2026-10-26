const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Disposition"
};

const ENGINES = [
  { name: "engine-1", host: "yt-dl.officialhectormanuel.workers.dev" },
  { name: "engine-2", host: "p.savenow.to" },
  { name: "fallback", host: "youtubei.googleapis.com" }
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

function sanitizeFilename(name) {
  if (!name || typeof name !== "string") return "youtube_media";
  return name.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim().slice(0, 100);
}

function extractVideoId(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([a-zA-Z0-9_-]{11})/i);
  return match ? match[1] : null;
}

async function fetchInnertube(videoId) {
  const key = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w";
  const url = `https://www.youtube.com/youtubei/v1/player?key=${key}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "com.google.android.youtube/20.34.37 (Linux; U; Android 11) gzip"
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.34.37",
            androidSdkVersion: 30,
            hl: "en",
            gl: "US"
          }
        }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.playabilityStatus?.status !== "OK") return null;
    return data;
  } catch {
    return null;
  }
}

async function fetchOEmbed(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

async function fetchPrexzy(videoId) {
  try {
    const res = await fetch(`https://prexzyapis.com/download/ytmp4?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && (data.info || data.qualities)) return data;
    }
  } catch {}
  return null;
}

async function fetchFromEdgeDownloader(videoId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const target = `https://yt-dl.officialhectormanuel.workers.dev/?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const res = await fetch(target, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.status && (data.videos || data.audio)) {
      return data;
    }
  } catch {
    clearTimeout(timer);
  }
  return null;
}

async function resolveFromSaveNow(videoId, cleanQuality, isAudio) {
  const format = isAudio ? "mp3" : cleanQuality;
  const target = `https://p.savenow.to/api/v2/download?format=${format}&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.url) return data.url;
    if (data?.progress_url) {
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 800));
        const pRes = await fetch(data.progress_url, {
          headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          if (pData?.success === 1 && pData?.download_url) {
            return pData.download_url;
          }
        }
      }
    }
  } catch {
    clearTimeout(timer);
  }
  return null;
}

async function resolveMediaStream(videoId, requestedQuality, isAudio) {
  const cleanQ = ["144", "240", "360", "480", "720", "1080", "1440", "2160"].includes(String(requestedQuality).replace("p", ""))
    ? String(requestedQuality).replace("p", "")
    : "1080";

  const edgeData = await fetchFromEdgeDownloader(videoId);
  if (edgeData) {
    if (isAudio && edgeData.audio) {
      return { source: "engine-1", url: edgeData.audio, quality: "mp3" };
    }
    const videos = edgeData.videos || {};
    const url = videos[cleanQ] || videos["1080"] || videos["720"] || videos["480"] || videos["360"] || videos["240"] || videos["144"] || Object.values(videos)[0];
    if (url) {
      const foundQ = Object.keys(videos).find(k => videos[k] === url) || cleanQ;
      return { source: "engine-1", url, quality: `${foundQ}p` };
    }
  }

  const snUrl = await resolveFromSaveNow(videoId, cleanQ, isAudio);
  if (snUrl) {
    return { source: "engine-2", url: snUrl, quality: isAudio ? "mp3" : `${cleanQ}p` };
  }

  const itData = await fetchInnertube(videoId);
  if (itData) {
    const streaming = itData.streamingData || {};
    if (isAudio) {
      const audioFormats = (streaming.adaptiveFormats || []).filter(f => f.mimeType?.startsWith("audio/"));
      const bestAudio = audioFormats.find(f => f.audioQuality === "AUDIO_QUALITY_MEDIUM") || audioFormats[0] || null;
      if (bestAudio?.url) {
        return { source: "fallback", url: bestAudio.url, quality: "m4a" };
      }
    } else {
      const progFormat = streaming.formats?.[0] || null;
      if (progFormat?.url) {
        return { source: "fallback", url: progFormat.url, quality: progFormat.qualityLabel || "360p" };
      }
    }
  }

  return null;
}

async function scrapeYouTube(videoId, requestedQuality, origin) {
  const cleanQ = ["144", "240", "360", "480", "720", "1080", "1440", "2160"].includes(String(requestedQuality).replace("p", ""))
    ? String(requestedQuality).replace("p", "")
    : "1080";

  const [edgeResult, itResult, oembedResult, prexzyResult] = await Promise.allSettled([
    fetchFromEdgeDownloader(videoId),
    fetchInnertube(videoId),
    fetchOEmbed(videoId),
    fetchPrexzy(videoId)
  ]);

  const edgeData = edgeResult.status === "fulfilled" ? edgeResult.value : null;
  const itData = itResult.status === "fulfilled" ? itResult.value : null;
  const oembed = oembedResult.status === "fulfilled" ? oembedResult.value : null;
  const prexzy = prexzyResult.status === "fulfilled" ? prexzyResult.value : null;

  if (!edgeData && !itData && !oembed && !prexzy) {
    throw new Error("Unable to retrieve YouTube video data from available engines");
  }

  const pInfo = prexzy?.info || {};
  const details = itData?.videoDetails || {};
  const streaming = itData?.streamingData || {};

  const title = edgeData?.title || pInfo.title || details.title || oembed?.title || `youtube_${videoId}`;
  const cleanTitle = sanitizeFilename(title);

  const author = details.author || pInfo.channel || pInfo.uploader || oembed?.author_name || edgeData?.creator || "";
  const channelId = details.channelId || pInfo.id || "";
  const duration = Number(details.lengthSeconds || pInfo.duration || 0);
  const views = Number(details.viewCount || pInfo.view_count || 0);
  const isLive = Boolean(details.isLiveContent);

  const progFormat = streaming.formats?.[0] || null;
  const audioFormats = (streaming.adaptiveFormats || []).filter(f => f.mimeType?.startsWith("audio/"));
  const bestAudio = audioFormats.find(f => f.audioQuality === "AUDIO_QUALITY_MEDIUM") || audioFormats[0] || null;

  const edgeVideos = edgeData?.videos || {};
  const primaryVideoUrl = edgeVideos[cleanQ]
    || edgeVideos["1080"]
    || edgeVideos["720"]
    || edgeVideos["480"]
    || edgeVideos["360"]
    || edgeVideos["240"]
    || edgeVideos["144"]
    || Object.values(edgeVideos)[0]
    || progFormat?.url
    || null;

  const activeQuality = Object.keys(edgeVideos).find(k => edgeVideos[k] === primaryVideoUrl)
    ? `${Object.keys(edgeVideos).find(k => edgeVideos[k] === primaryVideoUrl)}p`
    : (progFormat?.qualityLabel || `${cleanQ}p`);

  const primaryAudioUrl = edgeData?.audio || bestAudio?.url || null;

  const qualities = {};
  for (const q of ["2160", "1440", "1080", "720", "480", "360", "240", "144"]) {
    if (edgeVideos[q]) {
      qualities[`${q}p`] = edgeVideos[q];
    }
  }

  const thumbnails = details.thumbnail?.thumbnails?.length
    ? details.thumbnail.thumbnails
    : (pInfo.thumbnail
      ? [{ url: pInfo.thumbnail, width: 480, height: 360 }]
      : (edgeData?.thumbnail
        ? [{ url: edgeData.thumbnail, width: 480, height: 360 }]
        : [{ url: oembed?.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 }]));

  const videoDownloadUrl = primaryVideoUrl
    ? `${origin}/api/download?url=${encodeURIComponent(primaryVideoUrl)}&filename=${encodeURIComponent(cleanTitle + "_" + cleanQ + "p.mp4")}`
    : `${origin}/api/download?id=${videoId}&quality=${cleanQ}&type=video&filename=${encodeURIComponent(cleanTitle + "_" + cleanQ + "p.mp4")}`;

  const videoStreamUrl = primaryVideoUrl
    ? `${origin}/api/stream?url=${encodeURIComponent(primaryVideoUrl)}`
    : `${origin}/api/stream?id=${videoId}&quality=${cleanQ}&type=video`;

  const audioDownloadUrl = primaryAudioUrl
    ? `${origin}/api/download?url=${encodeURIComponent(primaryAudioUrl)}&filename=${encodeURIComponent(cleanTitle + "_audio." + (edgeData?.audio ? "mp3" : "m4a"))}`
    : `${origin}/api/download?id=${videoId}&type=audio&filename=${encodeURIComponent(cleanTitle + "_audio." + (edgeData?.audio ? "mp3" : "m4a"))}`;

  const audioStreamUrl = primaryAudioUrl
    ? `${origin}/api/stream?url=${encodeURIComponent(primaryAudioUrl)}`
    : `${origin}/api/stream?id=${videoId}&type=audio`;

  return {
    engine: edgeData ? "engine-1 (edge-ytdl)" : (itData ? "fallback (innertube)" : "engine-2 (savenow)"),
    id: videoId,
    title,
    channel: {
      id: channelId,
      name: author
    },
    duration,
    views,
    is_live: isLive,
    thumbnails,
    requested_quality: `${cleanQ}p`,
    available_qualities: edgeData?.available_qualities || ["1080p", "720p", "480p", "360p", "mp3"],
    engines: {
      active: edgeData ? "engine-1" : (itData ? "fallback" : "engine-2"),
      engine_1: "yt-dl.officialhectormanuel.workers.dev",
      engine_2: "p.savenow.to",
      fallback: "innertube-android"
    },
    media: {
      video: {
        quality: activeQuality,
        url: primaryVideoUrl || videoDownloadUrl,
        qualities: Object.keys(qualities).length ? qualities : null,
        download_url: videoDownloadUrl,
        stream_url: videoStreamUrl
      },
      audio: {
        format: edgeData?.audio ? "mp3" : "m4a",
        url: primaryAudioUrl || audioDownloadUrl,
        download_url: audioDownloadUrl,
        stream_url: audioStreamUrl
      }
    }
  };
}

async function pipeStream(targetUrl, request, filename, asAttachment) {
  const upstreamHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  };

  const range = request.headers.get("range");
  if (range) {
    upstreamHeaders["Range"] = range;
  }

  const upstream = await fetch(targetUrl, {
    method: "GET",
    headers: upstreamHeaders
  });

  const responseHeaders = new Headers(CORS_HEADERS);
  const isAudioFile = filename.endsWith(".mp3") || filename.endsWith(".m4a");
  const fallbackType = isAudioFile ? (filename.endsWith(".mp3") ? "audio/mpeg" : "audio/mp4") : "video/mp4";
  const contentType = upstream.headers.get("content-type") || fallbackType;
  responseHeaders.set("Content-Type", contentType);

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) responseHeaders.set("Content-Length", contentLength);

  const contentRange = upstream.headers.get("content-range");
  if (contentRange) responseHeaders.set("Content-Range", contentRange);

  const acceptRanges = upstream.headers.get("accept-ranges");
  if (acceptRanges) responseHeaders.set("Accept-Ranges", acceptRanges);

  responseHeaders.set(
    "Content-Disposition",
    asAttachment ? `attachment; filename="${filename}"` : "inline"
  );
  responseHeaders.set("Cache-Control", "public, max-age=86400");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  });
}

async function handleProxy(request, asAttachment) {
  const reqUrl = new URL(request.url);
  const rawId = reqUrl.searchParams.get("id");
  const rawUrl = reqUrl.searchParams.get("url");

  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    const isDirectMedia = !rawUrl.includes("youtube.com/") && !rawUrl.includes("youtu.be/");
    if (isDirectMedia) {
      try {
        const parsedTarget = new URL(rawUrl);
        const filename = reqUrl.searchParams.get("filename") || (parsedTarget.pathname.endsWith(".mp3") ? "youtube_audio.mp3" : "youtube_video.mp4");
        return await pipeStream(parsedTarget.toString(), request, sanitizeFilename(filename), asAttachment);
      } catch (err) {
        return json({ status: "error", message: `Proxy error: ${err.message}` }, 502);
      }
    }
  }

  const videoId = rawId || extractVideoId(rawUrl);
  const quality = reqUrl.searchParams.get("quality") || reqUrl.searchParams.get("q") || "1080";
  const type = reqUrl.searchParams.get("type") || "video";
  const isAudio = type === "audio" || quality === "mp3";

  let filename = reqUrl.searchParams.get("filename");
  if (!filename) {
    filename = isAudio
      ? `youtube_audio_${videoId || "media"}.mp3`
      : `youtube_${videoId || "media"}_${quality}.mp4`;
  }
  filename = sanitizeFilename(filename);

  if (videoId) {
    const resolved = await resolveMediaStream(videoId, quality, isAudio);
    if (resolved && resolved.url) {
      try {
        return await pipeStream(resolved.url, request, filename, asAttachment);
      } catch {}
    }
  }

  return json({ status: "error", message: "Missing valid video 'id' or media 'url' parameter" }, 400);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    const url = new URL(request.url);
    const origin = url.origin;
    const path = url.pathname;

    if (path === "/" || path === "/api") {
      return json({
        status: "online",
        service: "YouTube Scraper & Downloader API",
        version: "2.1.0",
        engines: [
          { name: "engine-1", host: "yt-dl.officialhectormanuel.workers.dev", status: "active" },
          { name: "engine-2", host: "p.savenow.to", status: "standby" },
          { name: "fallback", host: "youtubei.googleapis.com", status: "standby" }
        ],
        endpoints: {
          scrape: {
            method: ["GET", "POST"],
            path: "/api/scrape",
            params: {
              url: "YouTube video URL (watch/shorts/youtu.be) or 11-char video ID",
              quality: "Target resolution: 1080, 720, 480, 360 (default: 1080)"
            },
            example: `${origin}/api/scrape?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&quality=720`
          },
          download: {
            method: "GET",
            path: "/api/download",
            params: {
              url: "Direct stream URL returned in scrape response",
              id: "11-char YouTube video ID",
              quality: "Resolution: 1080, 720, 480, 360",
              type: "Media type: video or audio (default: video)",
              filename: "Optional custom output filename"
            },
            example: `${origin}/api/download?id=dQw4w9WgXcQ&quality=720&type=video`
          },
          stream: {
            method: "GET",
            path: "/api/stream",
            params: {
              url: "Direct stream URL returned in scrape response",
              id: "11-char YouTube video ID",
              quality: "Resolution: 1080, 720, 480, 360",
              type: "Media type: video or audio (default: video)"
            },
            example: `${origin}/api/stream?id=dQw4w9WgXcQ&quality=720`
          },
          health: {
            method: "GET",
            path: "/health"
          }
        }
      });
    }

    if (path === "/health") {
      return json({ status: "ok", timestamp: new Date().toISOString() });
    }

    if (path === "/api/download" || path === "/download") {
      return handleProxy(request, true);
    }

    if (path === "/api/stream" || path === "/stream") {
      return handleProxy(request, false);
    }

    if (["/api/scrape", "/scrape", "/api/video", "/api/info"].includes(path)) {
      let rawInput = null;
      let requestedQuality = "1080";

      if (request.method === "GET") {
        rawInput = url.searchParams.get("url") || url.searchParams.get("id");
        requestedQuality = url.searchParams.get("quality") || url.searchParams.get("q") || "1080";
      } else if (request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          try {
            const body = await request.json();
            rawInput = body.url || body.id || body.link;
            requestedQuality = body.quality || body.q || "1080";
          } catch {
            return json({ status: "error", message: "Invalid JSON body" }, 400);
          }
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
          const form = await request.formData();
          rawInput = form.get("url") || form.get("id") || form.get("link");
          requestedQuality = form.get("quality") || form.get("q") || "1080";
        }
      } else {
        return json({ status: "error", message: "Method not allowed" }, 405);
      }

      const videoId = extractVideoId(rawInput);
      if (!videoId) {
        return json({
          status: "error",
          message: "A valid YouTube video URL or 11-character video ID is required"
        }, 400);
      }

      try {
        const data = await scrapeYouTube(videoId, requestedQuality, origin);
        return json({
          status: "success",
          code: 200,
          data
        });
      } catch (err) {
        return json({
          status: "error",
          code: 500,
          message: err.message
        }, 500);
      }
    }

    return json({ status: "error", message: "Not found" }, 404);
  }
};
