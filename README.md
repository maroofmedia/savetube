# 🚀 SaveTube

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-1.0.0-green.svg)
![Node.js](https://img.shields.io/badge/Node.js-v18+-success)

**SaveTube** is a lightning-fast, ad-free, and open-source YouTube video and audio downloader. Built with Node.js and Vanilla JS, it delivers full-resolution MP4s (up to 4K) and high-quality MP3s directly to the browser — no sign-up required.

🔗 **Live:** [savetube.marooflone.com](https://savetube.marooflone.com)

---

## ✨ Features

- **No Ads, No BS** — A sleek, dark-themed, minimalist UI that gets out of your way.
- **High Resolution** — Downloads up to 4K video by grabbing the best available streams and merging them into a standard `.mp4` via FFmpeg.
- **Crystal Clear Audio** — One-click extraction of the best available audio into `.mp3`.
- **PWA Support** — Installable as a Progressive Web App with offline caching via a Service Worker.
- **Anti-Ban Architecture** — Routes all traffic through a SOCKS5 proxy to prevent IP rate-limiting from YouTube.
- **Self-Cleaning** — Automatically deletes temporary files from the server the moment a download completes, preventing disk-space exhaustion.
- **Rate Limited** — Built-in IP-based rate limiting (via `express-rate-limit`) to prevent server abuse.
- **Concurrency Control** — Caps simultaneous downloads to protect server resources.
- **Security Hardened** — Uses `helmet` for HTTP header security and `compression` for gzip responses.

---

## ⚙️ Prerequisites

Make sure you have the following installed on your server:

| Tool | Purpose |
|------|---------|
| **Node.js** (v18+) | Runtime |
| **yt-dlp** (keep up to date!) | YouTube extraction engine |
| **FFmpeg** | Audio/video merging & format conversion |
| **SOCKS5 Proxy** on port `40000` | Prevents YouTube IP bans (Cloudflare WARP recommended) |

---

## 🛠️ Installation & Setup

**1. Clone the repository**
```bash
git clone https://github.com/maroofmedia/savetube.git
cd savetube
```

**2. Install dependencies**
```bash
npm install
```

**3. Configure your SOCKS5 Proxy**

By default, `server.js` routes all yt-dlp traffic through `socks5://127.0.0.1:40000`. You must have a proxy running on this address, or YouTube will quickly rate-limit your server's IP.

> We recommend setting up [Cloudflare WARP](https://developers.cloudflare.com/warp-client/) in proxy mode.

**4. Start the server**
```bash
# Development (port 4000)
npm run dev

# Production
npm start
```

---

## 📡 API Endpoints

### `POST /api/info`
Fetches available video qualities, thumbnail, duration, channel, view count, and upload date.

- **Body:** `{ "url": "https://youtube.com/watch?v=..." }`
- **Rate Limit:** 15 requests / minute / IP

**Response:**
```json
{
  "title": "Video Title",
  "thumbnail": "https://...",
  "duration": 300,
  "channel": "Channel Name",
  "viewCount": 1000000,
  "uploadDate": "20240101",
  "qualities": [
    { "height": 1080, "label": "1080p", "filesize": 150000000 }
  ],
  "audioSize": 5000000
}
```

---

### `GET /api/download`
Initiates the download and streams the file directly to the browser.

| Param | Description |
|-------|-------------|
| `url` | The YouTube video URL |
| `type` | `video` or `audio` |
| `height` | Desired resolution, e.g. `1080` (video only) |
| `title` | Sanitized string used for the output filename |

- **Rate Limit:** 5 downloads / minute / IP
- **Concurrency:** Max 3 simultaneous downloads (configurable via `MAX_CONCURRENT` env var)

---

### `GET /api/health`
Returns server status, uptime, and active download count.

```json
{ "status": "ok", "uptime": 12345.67, "activeDownloads": 1 }
```

---

## 📁 Project Structure

```
savetube/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions → AWS EC2 auto-deploy
├── public/
│   ├── index.html              # Frontend
│   ├── style.css               # Dark theme, responsive design
│   ├── app.js                  # Client-side logic (vanilla JS)
│   ├── sw.js                   # Service Worker for PWA caching
│   └── manifest.json           # PWA manifest
├── server.js                   # Express server + yt-dlp download engine
├── package.json
└── .gitignore
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Backend** | Node.js, Express.js |
| **Security** | Helmet, CORS, express-rate-limit |
| **Proxy** | socks-proxy-agent (SOCKS5) |
| **Compression** | compression (gzip) |
| **Frontend** | Vanilla HTML5, CSS3, JavaScript |
| **Fonts** | Inter (Google Fonts) |
| **Download Engine** | yt-dlp (child process) |
| **Media Processing** | FFmpeg |
| **PWA** | Service Worker + Web App Manifest |
| **Deployment** | GitHub Actions → AWS EC2 |
| **Process Manager** | PM2 (recommended for production) |

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!
If you find a bug (especially if YouTube updates its layout and breaks the extractor), please open an issue or submit a Pull Request.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📜 License

Distributed under the MIT License. Built for educational and personal use.

---

<p align="center">Made with ❤️ by <a href="https://www.marooflone.com">Maroof Lone</a></p>