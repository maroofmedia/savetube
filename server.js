/* ═══════════════════════════════════════════════
   SaveTube — server.js
   ═══════════════════════════════════════════════ */
'use strict';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

// ── Config ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT, 10) || 3;

// ── App ─────────────────────────────────────────
const app = express();

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1kb' }));

const infoLimiter = rateLimit({
    windowMs: 60 * 1000, max: 15,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a moment.' },
});
const downloadLimiter = rateLimit({
    windowMs: 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many downloads. Please wait a moment.' },
});

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: NODE_ENV === 'production' ? '1d' : 0,
    etag: true,
}));

// ── yt-dlp flags ────────────────────────────────
const SPEED_FLAGS = [
    '--no-warnings', '--no-playlist', '--no-check-certificates',
    '--socket-timeout', '15', '--extractor-retries', '0',
];

// ── Standard YouTube heights ────────────────────
const STD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144];
function snapToStandard(h) {
    let best = STD_HEIGHTS[STD_HEIGHTS.length - 1], bestDiff = Infinity;
    for (const s of STD_HEIGHTS) {
        const diff = Math.abs(h - s);
        if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
    return best;
}

// ── Concurrency ─────────────────────────────────
let activeDownloads = 0;
function acquireSlot() {
    if (activeDownloads >= MAX_CONCURRENT) return false;
    activeDownloads++;
    return true;
}
function releaseSlot() { activeDownloads = Math.max(0, activeDownloads - 1); }

// ── Helper: run yt-dlp ──────────────────────────
function runYtDlp(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const proc = spawn('yt-dlp', [...SPEED_FLAGS, ...args]);
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('yt-dlp timed out')); }, timeoutMs);
        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('close', (code) => {
            clearTimeout(timer);
            code === 0 ? resolve(stdout) : reject(new Error(stderr || `yt-dlp exit ${code}`));
        });
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
}

// ── Helper: get Content-Length via HEAD request ──
function getContentLength(url) {
    return new Promise((resolve) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.request(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            resolve(parseInt(res.headers['content-length'], 10) || 0);
            res.resume(); // drain
        });
        req.on('error', () => resolve(0));
        req.setTimeout(8000, () => { req.destroy(); resolve(0); });
        req.end();
    });
}

// ── URL validation ──────────────────────────────
function isValidYouTubeURL(url) {
    if (typeof url !== 'string' || url.length > 500) return false;
    try {
        const parsed = new URL(url);
        return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'].includes(parsed.hostname);
    } catch { return false; }
}

// ── POST /api/info ──────────────────────────────
app.post('/api/info', infoLimiter, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (!isValidYouTubeURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

    try {
        const raw = await runYtDlp(['--dump-json', url], 60000);
        const info = JSON.parse(raw);

        // Collect ALL unique video heights
        const heightMap = new Map();
        for (const f of info.formats || []) {
            if (f.vcodec && f.vcodec !== 'none' && f.height) {
                const h = snapToStandard(f.height);
                const size = f.filesize || f.filesize_approx || 0;
                const existing = heightMap.get(h);
                if (!existing || size > existing.filesize) {
                    heightMap.set(h, { filesize: size });
                }
            }
        }

        const qualities = [...heightMap.entries()]
            .sort((a, b) => b[0] - a[0])
            .map(([h, data]) => ({ height: h, label: `${h}p`, filesize: data.filesize }));

        // Best audio size estimate
        let audioSize = 0;
        for (const f of info.formats || []) {
            if (f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')) {
                const size = f.filesize || f.filesize_approx || 0;
                if (size > audioSize) audioSize = size;
            }
        }

        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            channel: info.channel || info.uploader,
            viewCount: info.view_count,
            uploadDate: info.upload_date,
            qualities,
            audioSize,
        });
    } catch (err) {
        console.error('[INFO]', err.message);
        res.status(500).json({ error: 'Failed to fetch video info. Please check the URL.' });
    }
});

// ── GET /api/download ───────────────────────────
// Strategy: get direct YouTube CDN URLs and stream through.
// • Pre-muxed formats (≤720p): proxy stream from CDN with Content-Length → full browser progress
// • Merge formats (1080p+): pipe through ffmpeg that downloads + muxes → streaming MP4, no temp files
// • Audio: pipe through ffmpeg for mp3 conversion → streaming
app.get('/api/download', downloadLimiter, async (req, res) => {
    const { url, type, height, title } = req.query;
    if (!url || !type) return res.status(400).json({ error: 'url and type are required' });
    if (!isValidYouTubeURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });
    if (!acquireSlot()) return res.status(503).json({ error: 'Server busy. Please try again shortly.' });

    const safeTitle = (title || 'download')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ').trim().substring(0, 200) || 'download';

    const isAudio = type === 'audio';
    let released = false;
    const release = () => { if (!released) { released = true; releaseSlot(); } };
    res.on('close', release);

    try {
        if (isAudio) {
            // ── Audio: get direct URL → pipe through ffmpeg → mp3 stream ──
            const rawUrl = await runYtDlp(['--get-url', '-f', 'bestaudio', url]);
            const audioUrl = rawUrl.trim().split('\n')[0];

            // Get source audio size for approximate Content-Length
            const srcAudioSize = await getContentLength(audioUrl);

            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle + '.mp3')}"`);
            if (srcAudioSize > 0) res.setHeader('Content-Length', srcAudioSize);

            const ffmpeg = spawn('ffmpeg', [
                '-hide_banner', '-loglevel', 'error',
                '-i', audioUrl,
                '-vn', '-f', 'mp3', '-q:a', '0',
                'pipe:1',
            ]);
            ffmpeg.stdout.pipe(res);
            ffmpeg.stderr.on('data', (d) => console.error('[FFMPEG-AUDIO]', d.toString()));
            ffmpeg.on('close', release);
            ffmpeg.on('error', release);

        } else {
            const h = parseInt(height, 10) || 720;

            // Get direct CDN URL(s) for the requested quality
            const rawUrls = await runYtDlp([
                '--get-url', '-f',
                `best[height<=${h}][ext=mp4]/best[height<=${h}]/bestvideo[height<=${h}]+bestaudio`,
                url,
            ]);
            const urls = rawUrls.trim().split('\n').filter(Boolean);
            const filename = encodeURIComponent(safeTitle + '.mp4');

            if (urls.length === 1) {
                // ── Single pre-muxed URL: proxy stream from YouTube CDN ──
                const getter = urls[0].startsWith('https') ? https : http;
                getter.get(urls[0], { headers: { 'User-Agent': 'Mozilla/5.0' } }, (upstream) => {
                    if (upstream.statusCode >= 400) {
                        release();
                        if (!res.headersSent) res.status(502).json({ error: 'CDN error' });
                        return;
                    }
                    res.setHeader('Content-Type', 'video/mp4');
                    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                    if (upstream.headers['content-length']) {
                        res.setHeader('Content-Length', upstream.headers['content-length']);
                    }
                    upstream.pipe(res);
                    upstream.on('end', release);
                    upstream.on('error', () => { release(); res.end(); });
                }).on('error', (err) => {
                    release();
                    console.error('[CDN]', err.message);
                    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
                });

            } else if (urls.length >= 2) {
                // ── Two URLs (video + audio): merge via ffmpeg, stream directly ──
                const [vidSize, audSize] = await Promise.all([
                    getContentLength(urls[0]),
                    getContentLength(urls[1]),
                ]);
                const totalSize = vidSize + audSize;

                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                if (totalSize > 0) res.setHeader('Content-Length', totalSize);

                const ffmpeg = spawn('ffmpeg', [
                    '-hide_banner', '-loglevel', 'error',
                    '-i', urls[0],             // video stream URL
                    '-i', urls[1],             // audio stream URL
                    '-c', 'copy',              // no re-encoding, just remux
                    '-movflags', 'frag_keyframe+empty_moov',  // streaming-friendly MP4
                    '-f', 'mp4',
                    'pipe:1',
                ]);
                ffmpeg.stdout.pipe(res);
                ffmpeg.stderr.on('data', (d) => console.error('[FFMPEG-MERGE]', d.toString()));
                ffmpeg.on('close', release);
                ffmpeg.on('error', release);
            } else {
                release();
                res.status(500).json({ error: 'No download URL found' });
            }
        }
    } catch (err) {
        release();
        console.error('[DOWNLOAD]', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Download failed. Please try again.' });
    }
});

// ── Health check ────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), activeDownloads });
});

// ── SPA fallback ────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ───────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`🚀 SaveTube running at http://localhost:${PORT}  [${NODE_ENV}]`);
});

// ── Graceful shutdown ───────────────────────────
function shutdown(signal) {
    console.log(`\n${signal} — shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
