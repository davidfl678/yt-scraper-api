const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Disposition"
};

const MAX_DOWNLOAD_BYTES = 650 * 1024 * 1024;

const ENGINES = [
  { name: "engine-1", host: "yt-dl.officialhectormanuel.workers.dev", status: "active" },
  { name: "engine-2", host: "ytmp3.biz.pl", status: "active" },
  { name: "engine-3", host: "p.savenow.to", status: "standby" },
  { name: "fallback", host: "youtubei.googleapis.com", status: "standby" }
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

function formatBytesNumber(bytes) {
  if (!bytes || bytes <= 0) return null;
  const units = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
}

function formatBitrateBytes(bitrateKbps, durationSec) {
  if (!durationSec) return null;
  const bytes = (bitrateKbps * 1000 * durationSec) / 8;
  const units = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
}

function findQualitySize(qStr, jarVids, itData) {
  const qNum = String(qStr).match(/(\d+)/)?.[1];
  if (!qNum) return { size: null, size_formatted: null };

  if (Array.isArray(jarVids)) {
    const jarMatch = jarVids.find(v => {
      const vNum = String(v.quality || "").match(/(\d+)/)?.[1];
      return vNum === qNum;
    });
    if (jarMatch && typeof jarMatch.size === "number") {
      return {
        size: Math.round(jarMatch.size),
        size_formatted: jarMatch.sizeLabel || formatBytesNumber(jarMatch.size)
      };
    }
  }

  if (itData?.streamingData) {
    const allFormats = [
      ...(itData.streamingData.formats || []),
      ...(itData.streamingData.adaptiveFormats || [])
    ];
    const itMatch = allFormats.find(f => {
      const fNum = String(f.qualityLabel || f.quality || "").match(/(\d+)/)?.[1];
      return fNum === qNum && f.contentLength;
    });
    if (itMatch) {
      const numBytes = Number(itMatch.contentLength);
      return {
        size: numBytes,
        size_formatted: formatBytesNumber(numBytes)
      };
    }
  }

  return { size: null, size_formatted: null };
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

async function fetchYtMp3BizPl(videoId, origin) {
  try {
    const [pageRes, jarInfoRes, jarFormatsRes] = await Promise.allSettled([
      fetch(`https://ytmp3.biz.pl/?q=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, {
        headers: {
          "HX-Request": "true",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://ytmp3.biz.pl/"
        }
      }),
      fetch(`https://v2.y2jar.cc/i/${videoId}`, {
        headers: { "Accept": "application/json", "Referer": `https://v2.y2jar.cc/?id=${videoId}` }
      }),
      fetch(`https://v2.y2jar.cc/f/${videoId}`, {
        headers: { "Accept": "application/json", "Referer": `https://v2.y2jar.cc/?id=${videoId}` }
      })
    ]);

    let html = "";
    if (pageRes.status === "fulfilled" && pageRes.value.ok) {
      html = await pageRes.value.text();
    }

    const jarInfo = jarInfoRes.status === "fulfilled" && jarInfoRes.value.ok ? await jarInfoRes.value.json() : null;
    const jarFormats = jarFormatsRes.status === "fulfilled" && jarFormatsRes.value.ok ? await jarFormatsRes.value.json() : null;

    const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const infoMatch = html.match(/<div class="-mb-1 text-gray-500[^>]*>([^<]+)<\/div>/i);
    const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"[^>]*>/i);
    const thumbMatch = html.match(/<img[^>]+class="[^"]*rounded-lg[^"]*"[^>]+src="([^"]+)"[^>]*>/i)
      || html.match(/<img[^>]+src="([^"]+)"[^>]*alt="/i);

    let author = jarInfo?.author || "";
    let durationSec = jarInfo?.duration || 0;
    let durationFormatted = "";
    let date = "";

    if (infoMatch) {
      const parts = infoMatch[1].split(/&bull;|•/).map(p => p.trim());
      if (!author) author = parts[0] || "";
      durationFormatted = parts[1] || "";
      date = parts[2] || "";
    }

    if (!durationSec && durationFormatted) {
      const durParts = durationFormatted.split(":").map(Number);
      if (durParts.length === 2) durationSec = durParts[0] * 60 + durParts[1];
      else if (durParts.length === 3) durationSec = durParts[0] * 3600 + durParts[1] * 60 + durParts[2];
    }

    const origAudioSize = jarFormats?.audio?.size ? Math.round(jarFormats.audio.size) : null;
    const origAudioSizeFormatted = jarFormats?.audio?.sizeLabel || (origAudioSize ? formatBytesNumber(origAudioSize) : null);

    const audioBitrates = [
      {
        label: "MP3 Original",
        quality: "original",
        bitrate: "original",
        size: origAudioSize,
        size_formatted: origAudioSizeFormatted,
        download_allowed: origAudioSize ? origAudioSize <= MAX_DOWNLOAD_BYTES : true,
        download_url: `${origin}/api/download?id=${videoId}&type=audio&quality=original`,
        stream_url: `${origin}/api/stream?id=${videoId}&type=audio&quality=original`
      },
      ...([320, 256, 192, 128, 64].map(b => {
        const bSize = durationSec ? Math.round((b * 1000 * durationSec) / 8) : null;
        return {
          label: `MP3 ${b} Kbps`,
          quality: `${b}kbps`,
          bitrate: b,
          size: bSize,
          size_formatted: formatBitrateBytes(b, durationSec),
          download_allowed: bSize ? bSize <= MAX_DOWNLOAD_BYTES : true,
          download_url: `${origin}/api/download?id=${videoId}&type=audio&quality=${b}`,
          stream_url: `${origin}/api/stream?id=${videoId}&type=audio&quality=${b}`
        };
      }))
    ];

    const ytmp3Videos = (jarFormats?.videos || []).map(v => {
      const vSize = typeof v.size === "number" ? Math.round(v.size) : null;
      return {
        quality: v.quality,
        size: vSize,
        size_formatted: v.sizeLabel || formatBytesNumber(vSize),
        download_allowed: vSize ? vSize <= MAX_DOWNLOAD_BYTES : true
      };
    });

    const title = jarInfo?.title || (titleMatch ? titleMatch[1].trim() : "");
    const thumbnail = jarInfo?.thumbnailUrl?.split("?")[0]
      || (thumbMatch ? thumbMatch[1] : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);

    return {
      status: "active",
      host: "ytmp3.biz.pl",
      title,
      author,
      duration: durationSec || durationFormatted || 0,
      duration_formatted: durationFormatted,
      release_date: date,
      thumbnail,
      converter_url: iframeMatch ? iframeMatch[1] : `https://lil.sounddownmp3.com/ea.php?link=${videoId}`,
      web_url: `https://ytmp3.biz.pl/?q=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`,
      audio: {
        original: {
          quality: "original",
          size: origAudioSize,
          size_formatted: origAudioSizeFormatted,
          download_allowed: origAudioSize ? origAudioSize <= MAX_DOWNLOAD_BYTES : true
        },
        bitrates: audioBitrates
      },
      videos: ytmp3Videos,
      raw_jar_formats: jarFormats
    };
  } catch {
    return null;
  }
}

async function fetchFromEdgeDownloader(videoId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28000);
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
  const timer = setTimeout(() => controller.abort(), 12000);
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
    return { source: "engine-3", url: snUrl, quality: isAudio ? "mp3" : `${cleanQ}p` };
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

  const [edgeResult, ytmp3Result, itResult, oembedResult, prexzyResult] = await Promise.allSettled([
    fetchFromEdgeDownloader(videoId),
    fetchYtMp3BizPl(videoId, origin),
    fetchInnertube(videoId),
    fetchOEmbed(videoId),
    fetchPrexzy(videoId)
  ]);

  const edgeData = edgeResult.status === "fulfilled" ? edgeResult.value : null;
  const ytmp3Data = ytmp3Result.status === "fulfilled" ? ytmp3Result.value : null;
  const itData = itResult.status === "fulfilled" ? itResult.value : null;
  const oembed = oembedResult.status === "fulfilled" ? oembedResult.value : null;
  const prexzy = prexzyResult.status === "fulfilled" ? prexzyResult.value : null;

  if (!edgeData && !ytmp3Data && !itData && !oembed && !prexzy) {
    throw new Error("Unable to retrieve YouTube video data from available engines");
  }

  const pInfo = prexzy?.info || {};
  const details = itData?.videoDetails || {};
  const streaming = itData?.streamingData || {};

  const title = edgeData?.title || ytmp3Data?.title || pInfo.title || details.title || oembed?.title || `youtube_${videoId}`;
  const cleanTitle = sanitizeFilename(title);

  const author = ytmp3Data?.author || details.author || pInfo.channel || pInfo.uploader || oembed?.author_name || edgeData?.creator || "";
  const channelId = details.channelId || pInfo.id || "";
  const duration = Number(details.lengthSeconds || pInfo.duration || (typeof ytmp3Data?.duration === "number" ? ytmp3Data.duration : 0));
  const views = Number(details.viewCount || pInfo.view_count || 0);
  const isLive = Boolean(details.isLiveContent);

  const progFormat = streaming.formats?.[0] || null;
  const audioFormats = (streaming.adaptiveFormats || []).filter(f => f.mimeType?.startsWith("audio/"));
  const bestAudio = audioFormats.find(f => f.audioQuality === "AUDIO_QUALITY_MEDIUM") || audioFormats[0] || null;

  const edgeVideos = edgeData?.videos || {};
  const qualitiesMap = {};
  const qualitiesList = [];
  const jarVideos = ytmp3Data?.raw_jar_formats?.videos || ytmp3Data?.videos || [];

  for (const [key, val] of Object.entries(edgeVideos)) {
    const qLabel = key.endsWith("p") ? key : `${key}p`;
    qualitiesMap[qLabel] = val;

    const sizeInfo = findQualitySize(qLabel, jarVideos, itData);
    qualitiesList.push({
      quality: qLabel,
      size: sizeInfo.size,
      size_formatted: sizeInfo.size_formatted,
      download_allowed: sizeInfo.size ? sizeInfo.size <= MAX_DOWNLOAD_BYTES : true,
      url: val,
      download_url: `${origin}/api/download?url=${encodeURIComponent(val)}&filename=${encodeURIComponent(cleanTitle + "_" + qLabel + ".mp4")}`,
      stream_url: `${origin}/api/stream?url=${encodeURIComponent(val)}`
    });
  }

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

  const activeQuality = edgeVideos[cleanQ]
    ? `${cleanQ}p`
    : (Object.keys(qualitiesMap)[0] || (progFormat?.qualityLabel || `${cleanQ}p`));

  const primarySizeInfo = findQualitySize(activeQuality, jarVideos, itData);

  const rawAudioSize = ytmp3Data?.audio?.original?.size
    || (bestAudio?.contentLength ? Number(bestAudio.contentLength) : null);
  const audioSizeFormatted = ytmp3Data?.audio?.original?.size_formatted
    || (rawAudioSize ? formatBytesNumber(rawAudioSize) : null);

  const primaryAudioUrl = edgeData?.audio || bestAudio?.url || null;

  const thumbnails = details.thumbnail?.thumbnails?.length
    ? details.thumbnail.thumbnails
    : (ytmp3Data?.thumbnail
      ? [{ url: ytmp3Data.thumbnail, width: 480, height: 360 }]
      : (pInfo.thumbnail
        ? [{ url: pInfo.thumbnail, width: 480, height: 360 }]
        : (edgeData?.thumbnail
          ? [{ url: edgeData.thumbnail, width: 480, height: 360 }]
          : [{ url: oembed?.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 }])));

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

  const audioBitrates = ytmp3Data?.audio?.bitrates || [
    { label: "Original", quality: "original", size: rawAudioSize, size_formatted: audioSizeFormatted, download_allowed: rawAudioSize ? rawAudioSize <= MAX_DOWNLOAD_BYTES : true, download_url: audioDownloadUrl, stream_url: audioStreamUrl },
    { label: "320 Kbps", quality: "320kbps", bitrate: 320, size: duration ? Math.round(320 * 1000 * duration / 8) : null, size_formatted: formatBitrateBytes(320, duration), download_allowed: true, download_url: `${origin}/api/download?id=${videoId}&type=audio&quality=320`, stream_url: `${origin}/api/stream?id=${videoId}&type=audio&quality=320` },
    { label: "256 Kbps", quality: "256kbps", bitrate: 256, size: duration ? Math.round(256 * 1000 * duration / 8) : null, size_formatted: formatBitrateBytes(256, duration), download_allowed: true, download_url: `${origin}/api/download?id=${videoId}&type=audio&quality=256`, stream_url: `${origin}/api/stream?id=${videoId}&type=audio&quality=256` },
    { label: "192 Kbps", quality: "192kbps", bitrate: 192, size: duration ? Math.round(192 * 1000 * duration / 8) : null, size_formatted: formatBitrateBytes(192, duration), download_allowed: true, download_url: `${origin}/api/download?id=${videoId}&type=audio&quality=192`, stream_url: `${origin}/api/stream?id=${videoId}&type=audio&quality=192` },
    { label: "128 Kbps", quality: "128kbps", bitrate: 128, size: duration ? Math.round(128 * 1000 * duration / 8) : null, size_formatted: formatBitrateBytes(128, duration), download_allowed: true, download_url: `${origin}/api/download?id=${videoId}&type=audio&quality=128`, stream_url: `${origin}/api/stream?id=${videoId}&type=audio&quality=128` },
    { label: "64 Kbps", quality: "64kbps", bitrate: 64, size: duration ? Math.round(64 * 1000 * duration / 8) : null, size_formatted: formatBitrateBytes(64, duration), download_allowed: true, download_url: `${origin}/api/download?id=${videoId}&type=audio&quality=64`, stream_url: `${origin}/api/stream?id=${videoId}&type=audio&quality=64` }
  ];

  const ytmp3CleanVideos = (ytmp3Data?.videos || []).map(v => ({
    quality: v.quality,
    size: v.size,
    size_formatted: v.size_formatted,
    download_allowed: v.download_allowed
  }));

  return {
    engine: edgeData ? "engine-1 (edge-ytdl)" : (ytmp3Data ? "engine-2 (ytmp3)" : "engine-3 (savenow)"),
    id: videoId,
    title,
    channel: {
      id: channelId,
      name: author
    },
    duration: duration || ytmp3Data?.duration || 0,
    views,
    is_live: isLive,
    thumbnails,
    max_download_size: MAX_DOWNLOAD_BYTES,
    max_download_size_formatted: "650 MB",
    requested_quality: `${cleanQ}p`,
    available_qualities: edgeData?.available_qualities || ["1080p", "720p", "480p", "360p", "mp3"],
    engines: {
      active: edgeData ? "engine-1" : (ytmp3Data ? "engine-2" : "engine-3"),
      engine_1: "yt-dl.officialhectormanuel.workers.dev",
      engine_2: "ytmp3.biz.pl",
      engine_3: "p.savenow.to",
      fallback: "innertube-android"
    },
    sources: {
      edge_downloader: edgeData ? {
        status: "active",
        host: "yt-dl.officialhectormanuel.workers.dev",
        title: edgeData.title,
        audio: edgeData.audio,
        audio_size: rawAudioSize,
        audio_size_formatted: audioSizeFormatted,
        videos: qualitiesMap,
        videos_detailed: qualitiesList,
        available_qualities: edgeData.available_qualities
      } : {
        status: "offline",
        host: "yt-dl.officialhectormanuel.workers.dev"
      },
      ytmp3_biz_pl: ytmp3Data ? {
        status: "active",
        host: "ytmp3.biz.pl",
        title: ytmp3Data.title,
        author: ytmp3Data.author,
        duration: ytmp3Data.duration,
        duration_formatted: ytmp3Data.duration_formatted,
        release_date: ytmp3Data.release_date,
        thumbnail: ytmp3Data.thumbnail,
        converter_url: ytmp3Data.converter_url,
        web_url: ytmp3Data.web_url,
        audio: ytmp3Data.audio,
        videos: ytmp3CleanVideos
      } : {
        status: "offline",
        host: "ytmp3.biz.pl"
      }
    },
    media: {
      video: {
        quality: activeQuality,
        size: primarySizeInfo.size,
        size_formatted: primarySizeInfo.size_formatted,
        download_allowed: primarySizeInfo.size ? primarySizeInfo.size <= MAX_DOWNLOAD_BYTES : true,
        url: primaryVideoUrl || videoDownloadUrl,
        qualities: qualitiesList.length ? qualitiesList : null,
        qualities_map: Object.keys(qualitiesMap).length ? qualitiesMap : null,
        download_url: videoDownloadUrl,
        stream_url: videoStreamUrl
      },
      audio: {
        format: edgeData?.audio ? "mp3" : "m4a",
        quality: "original",
        size: rawAudioSize,
        size_formatted: audioSizeFormatted,
        download_allowed: rawAudioSize ? rawAudioSize <= MAX_DOWNLOAD_BYTES : true,
        url: primaryAudioUrl || audioDownloadUrl,
        download_url: audioDownloadUrl,
        stream_url: audioStreamUrl,
        bitrates: audioBitrates
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

  const contentLength = upstream.headers.get("content-length");
  if (asAttachment && contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
    return json({
      status: "error",
      code: 413,
      message: "File size exceeds the 650 MB download limit",
      file_size: Number(contentLength),
      file_size_formatted: formatBytesNumber(Number(contentLength)),
      max_download_size: MAX_DOWNLOAD_BYTES,
      max_download_size_formatted: "650 MB"
    }, 413);
  }

  const responseHeaders = new Headers(CORS_HEADERS);
  const isAudioFile = filename.endsWith(".mp3") || filename.endsWith(".m4a");
  const fallbackType = isAudioFile ? (filename.endsWith(".mp3") ? "audio/mpeg" : "audio/mp4") : "video/mp4";
  const contentType = upstream.headers.get("content-type") || fallbackType;
  responseHeaders.set("Content-Type", contentType);

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

  let body = upstream.body;
  if (asAttachment) {
    let bytesTransferred = 0;
    const limiter = new TransformStream({
      transform(chunk, controller) {
        bytesTransferred += chunk.length;
        if (bytesTransferred > MAX_DOWNLOAD_BYTES) {
          controller.error(new Error("File size exceeds 650 MB limit"));
        } else {
          controller.enqueue(chunk);
        }
      }
    });
    body = body.pipeThrough(limiter);
  }

  return new Response(body, {
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
      } catch (err) {
        return json({ status: "error", message: `Stream error: ${err.message}` }, 500);
      }
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
        version: "2.4.0",
        limits: {
          max_download_size: MAX_DOWNLOAD_BYTES,
          max_download_size_formatted: "650 MB"
        },
        engines: [
          { name: "engine-1", host: "yt-dl.officialhectormanuel.workers.dev", status: "active" },
          { name: "engine-2", host: "ytmp3.biz.pl", status: "active" },
          { name: "engine-3", host: "p.savenow.to", status: "standby" },
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
              quality: "Resolution: 1080, 720, 480, 360 or bitrate: 320, 256, 192, 128, 64",
              type: "Media type: video or audio (default: video)",
              filename: "Optional custom output filename"
            },
            notes: "Files larger than 650 MB cannot be downloaded via proxy",
            example: `${origin}/api/download?id=dQw4w9WgXcQ&quality=720&type=video`
          },
          stream: {
            method: "GET",
            path: "/api/stream",
            params: {
              url: "Direct stream URL returned in scrape response",
              id: "11-char YouTube video ID",
              quality: "Resolution: 1080, 720, 480, 360 or bitrate",
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
