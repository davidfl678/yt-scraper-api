const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Disposition"
};

const THIRD_PARTY_MIRRORS = [
  { name: "mirror-1", base: "https://cobaltapi.cjs.nz" },
  { name: "mirror-2", base: "https://rue-cobalt.xenon.zone" },
  { name: "mirror-3", base: "https://p.savenow.to" }
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

  if (!res.ok) throw new Error(`YouTube API returned status ${res.status}`);
  const data = await res.json();
  if (data.playabilityStatus?.status !== "OK") {
    throw new Error(data.playabilityStatus?.reason || "Video unavailable");
  }
  return data;
}

async function resolveFromCobalt(mirrorBase, videoId, cleanQuality, isAudio) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);

  const payload = {
    url: `https://www.youtube.com/watch?v=${videoId}`,
    youtubeVideoCodec: "h264"
  };

  if (isAudio) {
    payload.downloadMode = "audio";
    payload.audioFormat = "mp3";
  } else {
    payload.videoQuality = cleanQuality;
  }

  try {
    const res = await fetch(`${mirrorBase}/`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json();
    if (data && (data.status === "tunnel" || data.status === "redirect") && data.url) {
      return data.url;
    }
  } catch {
    clearTimeout(timer);
  }
  return null;
}

async function resolveFromSaveNow(videoId, cleanQuality, isAudio) {
  const format = isAudio ? "mp3" : cleanQuality;
  const url = `https://p.savenow.to/ajax/download.php?format=${format}&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.url) return data.url;
    if (data?.progress_url) {
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 600));
        const pRes = await fetch(data.progress_url, { headers: { "User-Agent": "Mozilla/5.0" } });
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
  const cleanQ = ["360", "480", "720", "1080", "1440", "2160"].includes(String(requestedQuality).replace("p", ""))
    ? String(requestedQuality).replace("p", "")
    : "1080";

  for (const mirror of THIRD_PARTY_MIRRORS) {
    if (mirror.base.includes("savenow.to")) {
      const url = await resolveFromSaveNow(videoId, cleanQ, isAudio);
      if (url) return { source: mirror.name, url, quality: `${cleanQ}p` };
    } else {
      const url = await resolveFromCobalt(mirror.base, videoId, cleanQ, isAudio);
      if (url) return { source: mirror.name, url, quality: `${cleanQ}p` };
    }
  }

  try {
    const itData = await fetchInnertube(videoId);
    const streaming = itData.streamingData || {};
    if (isAudio) {
      const audioFormats = (streaming.adaptiveFormats || []).filter(f => f.mimeType?.startsWith("audio/"));
      const bestAudio = audioFormats.find(f => f.audioQuality === "AUDIO_QUALITY_MEDIUM") || audioFormats[0] || null;
      if (bestAudio?.url) {
        return { source: "innertube-android", url: bestAudio.url, quality: "m4a" };
      }
    } else {
      const progFormat = streaming.formats?.[0] || null;
      if (progFormat?.url) {
        return { source: "innertube-android", url: progFormat.url, quality: progFormat.qualityLabel || "360p" };
      }
    }
  } catch {}

  return null;
}

async function fetchThirdPartyBatch(videoId, cleanQuality) {
  for (const mirror of THIRD_PARTY_MIRRORS) {
    if (mirror.base.includes("savenow.to")) {
      continue;
    }
    try {
      const [videoUrl, audioUrl] = await Promise.all([
        resolveFromCobalt(mirror.base, videoId, cleanQuality, false),
        resolveFromCobalt(mirror.base, videoId, cleanQuality, true)
      ]);
      if (videoUrl || audioUrl) {
        return {
          mirror: mirror.name,
          base: mirror.base,
          quality: `${cleanQuality}p`,
          videoUrl,
          audioUrl
        };
      }
    } catch {}
  }
  return null;
}

async function scrapeYouTube(videoId, requestedQuality, origin) {
  const cleanQ = ["360", "480", "720", "1080", "1440", "2160"].includes(String(requestedQuality).replace("p", ""))
    ? String(requestedQuality).replace("p", "")
    : "1080";

  const [innertubeResult, thirdPartyResult] = await Promise.allSettled([
    fetchInnertube(videoId),
    fetchThirdPartyBatch(videoId, cleanQ)
  ]);

  if (innertubeResult.status !== "fulfilled") {
    throw new Error(innertubeResult.reason?.message || "Failed to extract YouTube video");
  }

  const itData = innertubeResult.value;
  const details = itData.videoDetails || {};
  const streaming = itData.streamingData || {};

  const progFormat = streaming.formats?.[0] || null;
  const audioFormats = (streaming.adaptiveFormats || []).filter(f => f.mimeType?.startsWith("audio/"));
  const bestAudio = audioFormats.find(f => f.audioQuality === "AUDIO_QUALITY_MEDIUM") || audioFormats[0] || null;

  const tp = thirdPartyResult.status === "fulfilled" ? thirdPartyResult.value : null;

  const hdVideoUrl = tp?.videoUrl || null;
  const directMp4Url = progFormat?.url || null;
  const mp3Url = tp?.audioUrl || null;
  const directAudioUrl = bestAudio?.url || null;

  const primaryVideoDownload = hdVideoUrl || directMp4Url;
  const primaryAudioDownload = mp3Url || directAudioUrl;
  const activeQuality = tp?.quality || (progFormat?.qualityLabel || "360p");

  const cleanTitle = sanitizeFilename(details.title || `youtube_${videoId}`);

  const thumbnails = details.thumbnail?.thumbnails || [
    { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 }
  ];

  return {
    engine: tp ? `hybrid (${tp.mirror})` : "youtube_innertube",
    id: videoId,
    title: details.title || "",
    channel: {
      id: details.channelId || "",
      name: details.author || ""
    },
    duration: Number(details.lengthSeconds || 0),
    views: Number(details.viewCount || 0),
    is_live: Boolean(details.isLiveContent),
    thumbnails,
    requested_quality: `${cleanQ}p`,
    available_qualities: ["1080p", "720p", "480p", "360p", "mp3"],
    mirrors: {
      active: tp ? tp.mirror : "innertube-android",
      mirror_1: "cobaltapi.cjs.nz",
      mirror_2: "rue-cobalt.xenon.zone",
      mirror_3: "p.savenow.to",
      fallback: "innertube-android"
    },
    media: {
      video: {
        quality: activeQuality,
        url: primaryVideoDownload,
        fallback_360p_url: directMp4Url,
        download_url: `${origin}/api/download?id=${videoId}&quality=${cleanQ}&type=video&filename=${encodeURIComponent(cleanTitle + "_" + cleanQ + "p.mp4")}`,
        stream_url: `${origin}/api/stream?id=${videoId}&quality=${cleanQ}&type=video`
      },
      audio: {
        format: mp3Url ? "mp3" : "m4a",
        url: primaryAudioDownload,
        fallback_url: directAudioUrl,
        download_url: `${origin}/api/download?id=${videoId}&type=audio&filename=${encodeURIComponent(cleanTitle + "_audio." + (mp3Url ? "mp3" : "m4a"))}`,
        stream_url: `${origin}/api/stream?id=${videoId}&type=audio`
      }
    }
  };
}

async function pipeStream(targetUrl, request, filename, asAttachment) {
  const upstreamHeaders = {
    "User-Agent": "com.google.android.youtube/20.34.37 (Linux; U; Android 11) gzip"
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

  if (rawUrl) {
    let parsedTarget;
    try {
      parsedTarget = new URL(rawUrl);
      if (!["http:", "https:"].includes(parsedTarget.protocol)) {
        throw new Error("Invalid protocol");
      }
      return await pipeStream(parsedTarget.toString(), request, filename, asAttachment);
    } catch (err) {
      return json({ status: "error", message: `Proxy error: ${err.message}` }, 502);
    }
  }

  return json({ status: "error", message: "Missing video 'id' or 'url' parameter" }, 400);
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
        version: "2.0.0",
        mirrors: [
          { name: "mirror-1", host: "cobaltapi.cjs.nz", status: "active" },
          { name: "mirror-2", host: "rue-cobalt.xenon.zone", status: "active" },
          { name: "mirror-3", host: "p.savenow.to", status: "standby" },
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
