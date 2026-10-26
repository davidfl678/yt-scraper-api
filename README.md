<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/your-username/youtube-scraper-api">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers" />
  </a>
</p>

<p align="center">
  <img src="https://www.gstatic.com/youtube/img/promos/growth/YTP_logo_social_1200x630.png?days_since_epoch=20752" width="320" alt="YouTube Logo" />
</p>

<h1 align="center">🎬 YouTube Scraper & Downloader API</h1>

<p align="center">
  <strong>High-performance, serverless YouTube metadata scraper, multi-quality video downloader, and MP3 audio converter API designed for Cloudflare Workers.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Cloudflare_Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/Runtime-V8_Worker_Isolate-3178C6?style=for-the-badge&logo=javascript&logoColor=white" alt="V8 Engine" />
  <img src="https://img.shields.io/badge/Max_Download-650_MB_Cap-E50914?style=for-the-badge" alt="650 MB Limit" />
  <img src="https://img.shields.io/badge/CORS-Universal_(*)-success?style=for-the-badge" alt="CORS" />
  <img src="https://img.shields.io/badge/Dependencies-Zero_npm-black?style=for-the-badge" alt="Zero Dependencies" />
</p>

---

## 📑 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [Architecture & Engine Sources](#-architecture--engine-sources)
- [650 MB Download Limit & Rate Protection](#-650-mb-download-limit--rate-protection)
- [Raw File Size Reporting](#-raw-file-size-reporting)
- [Audio & Video Quality Specifications](#-audio--video-quality-specifications)
- [API Endpoints Reference](#-api-endpoints-reference)
  - [1. Service Health & Status](#1-service-health--status)
  - [2. Scrape Video & Audio Metadata](#2-scrape-video--audio-metadata)
  - [3. Direct Download with Custom Filename](#3-direct-download-with-custom-filename)
  - [4. Dynamic Media Stream Proxy](#4-dynamic-media-stream-proxy)
- [Deployment Guide](#-deployment-guide)
  - [Option 1: One-Click Deploy Button](#option-1-one-click-deploy-button)
  - [Option 2: Cloudflare Dashboard (Web UI)](#option-2-cloudflare-dashboard-web-ui)
  - [Option 3: Wrangler CLI](#option-3-wrangler-cli)
- [Configuration (`wrangler.toml`)](#-configuration-wranglertoml)
- [License & Disclaimer](#-license--disclaimer)

---

## 🌟 Overview

The **YouTube Scraper & Downloader API** is a pure serverless REST API that extracts complete YouTube video metadata, direct multi-resolution MP4 video streams (`144p` up to `2160p` 4K), and high-bitrate MP3 audio streams. It does not require any browser binaries (like Puppeteer or Playwright), operates with zero npm dependencies, and runs directly on Cloudflare's global edge network across 300+ locations.

---

## ✨ Key Features

- **Dual Primary Engine Integration:** Aggregates streams from `yt-dl.officialhectormanuel.workers.dev` and detailed bitrate analysis from `ytmp3.biz.pl`.
- **Full Bitrate MP3 Audio Extraction:** Provides instant calculations and direct downloads for Original, 320 Kbps, 256 Kbps, 192 Kbps, 128 Kbps, and 64 Kbps MP3 streams.
- **Multi-Resolution Video Downloads:** Supports 144p, 240p, 360p, 480p, 720p HD, 1080p Full HD, 1440p 2K, and 2160p 4K.
- **Raw File Size Data:** Returns both raw integer bytes (`size`) and human-readable formatted sizes (`size_formatted`) for every video quality and audio bitrate.
- **650 MB Download Protection:** Enforces a strict `650 MB` limit on proxy downloads to prevent Worker memory exhaustion and timeouts.
- **Direct Edge Streaming:** Built-in `/api/stream` endpoint supports `Accept-Ranges: bytes` and `206 Partial Content` for HTML5 video/audio players and seek operations.
- **Custom Filename Proxy:** Download links trigger `Content-Disposition: attachment` with sanitized video title filenames.
- **Universal CORS:** Standard CORS headers enabled on all responses for seamless frontend app and bot integration.

---

## 🏗 Architecture & Engine Sources

```text
                                Client Request
                                      │
         ┌────────────────────────────┴────────────────────────────┐
         │                                                         │
    /api/scrape                                           /api/download / /api/stream
  (Extract Metadata)                                    (Dynamic Streaming & Proxy)
         │                                                         │
         ▼                                                         ▼
  Multi-Engine Parallel Query:                            Content-Length Inspection:
  ├── Engine 1: yt-dl.officialhectormanuel.workers.dev   ├── If Size > 650 MB -> HTTP 413
  ├── Engine 2: ytmp3.biz.pl & v2.y2jar.cc                └── If Size <= 650 MB -> Stream directly
  ├── Engine 3: p.savenow.to (Standby Fallback)                     │
  └── Fallback: Innertube Android API                               ▼
                                                        - 206 Partial Content (Seeking)
                                                        - Content-Disposition: attachment
                                                        - Correct Audio/Video MIME type
```

| Engine | Host | Purpose | Status |
|:---|:---|:---|:---|
| **Engine 1** | `yt-dl.officialhectormanuel.workers.dev` | Multi-quality MP4 video streams (`144p` - `2160p`) & direct MP3 stream | Primary |
| **Engine 2** | `ytmp3.biz.pl` (`v2.y2jar.cc`) | Metadata parsing, video sizes & MP3 bitrate matrix (`64k` - `320k`) | Primary |
| **Engine 3** | `p.savenow.to` | Progressive fallback converter for MP4/MP3 | Standby |
| **Fallback** | `youtubei.googleapis.com` | Official Android Innertube client fallback | Standby |

---

## 🛡 650 MB Download Limit & Rate Protection

To guarantee stable streaming, protect Worker memory, and adhere to Cloudflare Worker limits, the API enforces a strict **650 MB (`681,574,400` bytes)** maximum download cap:

1. **Header-Level Rejection:** If upstream `Content-Length` exceeds `681,574,400` bytes, the Worker immediately terminates the connection and returns **HTTP 413 (Payload Too Large)** without consuming Worker bandwidth.
2. **Chunk-Level Stream Guard:** For streams without a `Content-Length` header or chunked transfers, an internal `TransformStream` counts bytes transmitted in real-time. If the stream reaches 650 MB, it safely cuts the connection.
3. **Scrape Response Flagging:** Every video and audio item in `/api/scrape` includes `download_allowed: true/false`, indicating whether the format fits within the 650 MB limit.

### HTTP 413 Error Response Example:
```json
{
  "status": "error",
  "code": 413,
  "message": "File size exceeds the 650 MB download limit",
  "file_size": 734003200,
  "file_size_formatted": "700 MB",
  "max_download_size": 681574400,
  "max_download_size_formatted": "650 MB"
}
```

---

## 📊 Raw File Size Reporting

Every media format exposes its exact byte count alongside its human-readable representation:

- `size`: Unsigned integer representing exact bytes (e.g. `7170832`)
- `size_formatted`: Formatted string (e.g. `"6.84 MB"`, `"554.69 KB"`)
- `download_allowed`: Boolean indicating whether file size is `<= 650 MB`

---

## 🎧 Audio & Video Quality Specifications

### Audio Bitrates (MP3)
- **MP3 Original:** Exact source audio stream size (approx. 128-160 Kbps AAC/Opus transcode)
- **MP3 320 Kbps:** Ultra high quality studio audio
- **MP3 256 Kbps:** High quality audio
- **MP3 192 Kbps:** Standard high fidelity
- **MP3 128 Kbps:** Standard mobile quality
- **MP3 64 Kbps:** Data saver / low bandwidth

### Video Resolutions (MP4)
- **2160p (4K UHD):** 3840x2160
- **1440p (2K QHD):** 2560x1440
- **1080p (Full HD):** 1920x1080 (up to 60fps)
- **720p (HD):** 1280x720
- **480p (SD):** 854x480
- **360p:** 640x360
- **240p:** 426x240
- **144p:** 256x144

---

## 📡 API Endpoints Reference

Base URL: `https://<your-worker-name>.<your-subdomain>.workers.dev`

---

### 1. Service Health & Status

Returns server status, engine statuses, and download limit configurations.

- **Method:** `GET`
- **Path:** `/` or `/api` or `/health`

```bash
curl "https://your-worker.workers.dev/health"
```

```json
{
  "status": "ok",
  "timestamp": "2026-10-26T12:00:00.000Z"
}
```

---

### 2. Scrape Video & Audio Metadata

Extracts complete video metadata, stream links, and size information across all available resolutions.

- **Method:** `GET` or `POST`
- **Path:** `/api/scrape` *(Aliases: `/scrape`, `/api/video`, `/api/info`)*

#### Query Parameters:

| Parameter | Type | Required | Description |
|:---|:---|:---|:---|
| `url` / `id` | string | Yes | YouTube video URL (watch/shorts/youtu.be) or 11-char video ID |
| `quality` | string | No | Preferred video resolution: `1080`, `720`, `480`, `360` (Default: `1080`) |

#### Example Request:

```bash
curl "https://your-worker.workers.dev/api/scrape?url=https://www.youtube.com/watch?v=HE0LXtwiZd8&quality=1080"
```

#### JSON Response Schema:

```json
{
  "status": "success",
  "code": 200,
  "data": {
    "engine": "engine-1 (edge-ytdl)",
    "id": "HE0LXtwiZd8",
    "title": "COSMIC TECLAS (Slowed)",
    "channel": {
      "id": "",
      "name": "DJ Raulipues - Topic"
    },
    "duration": 71,
    "views": 0,
    "is_live": false,
    "thumbnails": [
      {
        "url": "https://i.ytimg.com/vi/HE0LXtwiZd8/maxresdefault.jpg",
        "width": 480,
        "height": 360
      }
    ],
    "max_download_size": 681574400,
    "max_download_size_formatted": "650 MB",
    "requested_quality": "1080p",
    "available_qualities": [
      "1080",
      "720",
      "480",
      "360",
      "240",
      "144",
      "mp3"
    ],
    "sources": {
      "edge_downloader": {
        "status": "active",
        "host": "yt-dl.officialhectormanuel.workers.dev",
        "title": "COSMIC TECLAS (Slowed)",
        "audio": "https://yt-dl.officialhectormanuel.workers.dev/stream?id=HE0LXtwiZd8&format=mp3&key=...",
        "audio_size": 1162066,
        "audio_size_formatted": "1.11 MB",
        "videos": {
          "144p": "https://yt-dl.officialhectormanuel.workers.dev/stream?...",
          "240p": "https://yt-dl.officialhectormanuel.workers.dev/stream?...",
          "360p": "https://yt-dl.officialhectormanuel.workers.dev/stream?...",
          "480p": "https://yt-dl.officialhectormanuel.workers.dev/stream?...",
          "720p": "https://yt-dl.officialhectormanuel.workers.dev/stream?...",
          "1080p": "https://yt-dl.officialhectormanuel.workers.dev/stream?..."
        }
      },
      "ytmp3_biz_pl": {
        "status": "active",
        "host": "ytmp3.biz.pl",
        "title": "DJ Raulipues, Akrai & -Prey - COSMIC TECLAS (Slowed)",
        "author": "DJ Raulipues - Topic",
        "duration": 71,
        "audio": {
          "original": {
            "quality": "original",
            "size": 1162066,
            "size_formatted": "1.11 MB",
            "download_allowed": true
          },
          "bitrates": [
            {
              "label": "MP3 Original",
              "quality": "original",
              "bitrate": "original",
              "size": 1162066,
              "size_formatted": "1.11 MB",
              "download_allowed": true,
              "download_url": "https://your-worker.workers.dev/api/download?id=HE0LXtwiZd8&type=audio&quality=original",
              "stream_url": "https://your-worker.workers.dev/api/stream?id=HE0LXtwiZd8&type=audio&quality=original"
            },
            {
              "label": "MP3 320 Kbps",
              "quality": "320kbps",
              "bitrate": 320,
              "size": 2840000,
              "size_formatted": "2.71 MB",
              "download_allowed": true,
              "download_url": "https://your-worker.workers.dev/api/download?id=HE0LXtwiZd8&type=audio&quality=320",
              "stream_url": "https://your-worker.workers.dev/api/stream?id=HE0LXtwiZd8&type=audio&quality=320"
            }
          ]
        },
        "videos": [
          { "quality": "1080p", "size": 7170832, "size_formatted": "6.84 MB", "download_allowed": true },
          { "quality": "720p", "size": 4264470, "size_formatted": "4.07 MB", "download_allowed": true },
          { "quality": "480p", "size": 2787791, "size_formatted": "2.66 MB", "download_allowed": true }
        ]
      }
    },
    "media": {
      "video": {
        "quality": "1080p",
        "size": 7170832,
        "size_formatted": "6.84 MB",
        "download_allowed": true,
        "url": "https://yt-dl.officialhectormanuel.workers.dev/stream?id=HE0LXtwiZd8&format=1080&...",
        "qualities": [
          {
            "quality": "1080p",
            "size": 7170832,
            "size_formatted": "6.84 MB",
            "download_allowed": true,
            "url": "https://yt-dl.officialhectormanuel.workers.dev/stream?...",
            "download_url": "https://your-worker.workers.dev/api/download?url=...",
            "stream_url": "https://your-worker.workers.dev/api/stream?url=..."
          }
        ],
        "download_url": "https://your-worker.workers.dev/api/download?id=HE0LXtwiZd8&quality=1080&type=video",
        "stream_url": "https://your-worker.workers.dev/api/stream?id=HE0LXtwiZd8&quality=1080&type=video"
      },
      "audio": {
        "format": "mp3",
        "quality": "original",
        "size": 1162066,
        "size_formatted": "1.11 MB",
        "download_allowed": true,
        "url": "https://yt-dl.officialhectormanuel.workers.dev/stream?id=HE0LXtwiZd8&format=mp3&...",
        "download_url": "https://your-worker.workers.dev/api/download?id=HE0LXtwiZd8&type=audio",
        "stream_url": "https://your-worker.workers.dev/api/stream?id=HE0LXtwiZd8&type=audio",
        "bitrates": [
          {
            "label": "MP3 Original",
            "quality": "original",
            "size": 1162066,
            "size_formatted": "1.11 MB",
            "download_allowed": true,
            "download_url": "https://your-worker.workers.dev/api/download?id=HE0LXtwiZd8&type=audio&quality=original",
            "stream_url": "https://your-worker.workers.dev/api/stream?id=HE0LXtwiZd8&type=audio&quality=original"
          },
          {
            "label": "MP3 320 Kbps",
            "quality": "320kbps",
            "bitrate": 320,
            "size": 2840000,
            "size_formatted": "2.71 MB",
            "download_allowed": true,
            "download_url": "https://your-worker.workers.dev/api/download?id=HE0LXtwiZd8&type=audio&quality=320",
            "stream_url": "https://your-worker.workers.dev/api/stream?id=HE0LXtwiZd8&type=audio&quality=320"
          }
        ]
      }
    }
  }
}
```

---

### 3. Direct Download with Custom Filename

Triggers direct browser download (`Content-Disposition: attachment`). Resolves the stream dynamically and enforces the 650 MB limit.

- **Method:** `GET`
- **Path:** `/api/download` *(Alias: `/download`)*

#### Query Parameters:

| Parameter | Type | Required | Description |
|:---|:---|:---|:---|
| `id` / `url` | string | Yes | YouTube video ID, watch URL, or direct stream URL |
| `quality` | string | No | Desired resolution (`1080`, `720`, `480`, `360`) or bitrate (`320`, `256`, `192`, `128`, `64`) |
| `type` | string | No | Media type: `video` (default) or `audio` |
| `filename` | string | No | Custom file name (e.g. `Song.mp3` or `Video.mp4`) |

#### Examples:

```bash
# Download 1080p MP4 Video
curl -L -O "https://your-worker.workers.dev/api/download?id=HE0LXtwiZd8&quality=1080&type=video"

# Download 320 Kbps MP3 Audio
curl -L -O "https://your-worker.workers.dev/api/download?id=HE0LXtwiZd8&type=audio&quality=320"
```

---

### 4. Dynamic Media Stream Proxy

Streams video or audio with `Content-Disposition: inline` and full `Accept-Ranges: bytes` support. Ideal for HTML5 `<video>` or `<audio>` player embedding, mobile apps, and seeking.

- **Method:** `GET`
- **Path:** `/api/stream` *(Alias: `/stream`)*

```html
<!-- HTML5 Video Embedding with Seeking -->
<video controls width="100%" height="auto" src="https://your-worker.workers.dev/api/stream?id=HE0LXtwiZd8&quality=720&type=video"></video>

<!-- HTML5 Audio Embedding -->
<audio controls src="https://your-worker.workers.dev/api/stream?id=HE0LXtwiZd8&type=audio"></audio>
```

---

## 🚀 Deployment Guide

### Option 1: One-Click Deploy Button

Click the banner below to fork and deploy directly to your Cloudflare account in seconds:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/your-username/youtube-scraper-api)

---

### Option 2: Cloudflare Dashboard (Web UI)

1. Log into your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **Compute (Workers) -> Workers & Pages**.
3. Click **Create Application** -> **Create Worker**.
4. Choose a name (e.g., `youtube-scraper-api`) and click **Deploy**.
5. Once created, click **Edit code** in the top-right corner.
6. Paste the entire contents of [`src/index.js`](./src/index.js) into the code editor.
7. Click **Deploy**. Your API is live worldwide instantly!

---

### Option 3: Wrangler CLI

Ensure you have [Node.js](https://nodejs.org/) installed, then run:

```bash
# Clone the repository
git clone https://github.com/your-username/youtube-scraper-api.git
cd youtube-scraper-api

# Install Wrangler globally or locally
npm install -g wrangler

# Authenticate with Cloudflare
wrangler login

# Deploy directly to Cloudflare Workers
wrangler deploy
```

---

## ⚙ Configuration (`wrangler.toml`)

Your `wrangler.toml` file should look like this:

```toml
name = "youtube-scraper-api"
main = "src/index.js"
compatibility_date = "2024-03-20"
```

---

## 📜 License & Disclaimer

This project is licensed under the MIT License.

*Disclaimer: This project is intended for educational, testing, and personal backup purposes. Please respect YouTube's Terms of Service and content creators' intellectual property rights.*
