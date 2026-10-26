const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Disposition"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
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

async function fetchThirdParty(ytUrl, requestedQuality) {
  const mirrors = [
    "https://rue-cobalt.xenon.zone",
    "https://cobaltapi.cjs.nz"
  ];

  const targetQuality = ["360", "480", "720", "1080", "1440", "2160"].includes(String(requestedQuality))
    ? String(requestedQuality)
    : "1080";

  for (const mirror of mirrors) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);

      const [videoRes, audioRes] = await Promise.allSettled([
        fetch(`${mirror}/`, {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ url: ytUrl, videoQuality: targetQuality }),
          signal: controller.signal
        }),
        fetch(`${mirror}/`, {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ url: ytUrl, downloadMode: "audio", audioFormat: "mp3" }),
          signal: controller.signal
        })
      ]);

      clearTimeout(timer);

      let videoUrl = null;
      let audioUrl = null;

      if (videoRes.status === "fulfilled" && videoRes.value.ok) {
        const vJson = await videoRes.value.json();
        if (vJson.status === "tunnel" || vJson.status === "redirect") {
          videoUrl = vJson.url;
        }
      }

      if (audioRes.status === "fulfilled" && audioRes.value.ok) {
        const aJson = await audioRes.value.json();
        if (aJson.status === "tunnel" || aJson.status === "redirect") {
          audioUrl = aJson.url;
        }
      }

      if (videoUrl || audioUrl) {
        return {
          mirror,
          quality: `${targetQuality}p`,
          videoUrl,
          audioUrl
        };
      }
    } catch {
    }
  }
  return null;
}

async function scrapeYouTube(videoId, requestedQuality, origin) {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const [innertubeResult, thirdPartyResult] = await Promise.allSettled([
    fetchInnertube(videoId),
    fetchThirdParty(ytUrl, requestedQuality)
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
    available_qualities: ["1080p", "720p", "480p", "360p", "mp3"],
    media: {
      video: {
        quality: activeQuality,
        url: primaryVideoDownload,
        fallback_360p_url: directMp4Url,
        download_url: primaryVideoDownload
          ? `${origin}/api/download?url=${encodeURIComponent(primaryVideoDownload)}&filename=youtube_${videoId}_${activeQuality}.mp4`
          : null,
        stream_url: (directMp4Url || primaryVideoDownload)
          ? `${origin}/api/stream?url=${encodeURIComponent(directMp4Url || primaryVideoDownload)}`
          : null
      },
      audio: {
        format: mp3Url ? "mp3" : "m4a",
        url: primaryAudioDownload,
        fallback_url: directAudioUrl,
        download_url: primaryAudioDownload
          ? `${origin}/api/download?url=${encodeURIComponent(primaryAudioDownload)}&filename=youtube_audio_${videoId}.${mp3Url ? "mp3" : "m4a"}`
          : null,
        stream_url: (directAudioUrl || primaryAudioDownload)
          ? `${origin}/api/stream?url=${encodeURIComponent(directAudioUrl || primaryAudioDownload)}`
          : null
      }
    }
  };
}

async function handleProxy(request, asAttachment) {
  const reqUrl = new URL(request.url);
  const targetUrl = reqUrl.searchParams.get("url");
  const filename = reqUrl.searchParams.get("filename") || "youtube_media.mp4";

  if (!targetUrl) {
    return json({ status: "error", message: "Missing 'url' query parameter" }, 400);
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsedTarget.protocol)) {
      throw new Error("Invalid protocol");
    }
  } catch {
    return json({ status: "error", message: "Invalid media URL" }, 400);
  }

  const upstreamHeaders = {
    "User-Agent": "com.google.android.youtube/20.34.37 (Linux; U; Android 11) gzip"
  };

  const range = request.headers.get("range");
  if (range) {
    upstreamHeaders["Range"] = range;
  }

  try {
    const upstream = await fetch(parsedTarget.toString(), {
      method: "GET",
      headers: upstreamHeaders
    });

    const responseHeaders = new Headers(CORS_HEADERS);
    const contentType = upstream.headers.get("content-type") || (filename.endsWith(".mp3") ? "audio/mpeg" : (filename.endsWith(".m4a") ? "audio/mp4" : "video/mp4"));
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
  } catch (err) {
    return json({ status: "error", message: `Proxy error: ${err.message}` }, 502);
  }
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
        version: "1.1.0",
        endpoints: {
          scrape: {
            method: ["GET", "POST"],
            path: "/api/scrape",
            params: {
              url: "YouTube video URL (watch/shorts/youtu.be) or 11-char video ID",
              quality: "Optional video resolution: 1080, 720, 480, 360 (default: 1080)"
            },
            example: `${origin}/api/scrape?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&quality=1080`
          },
          download: {
            method: "GET",
            path: "/api/download",
            params: {
              url: "Direct media URL",
              filename: "Optional output filename (default: youtube_media.mp4)"
            }
          },
          stream: {
            method: "GET",
            path: "/api/stream",
            params: {
              url: "Direct media URL"
            }
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
