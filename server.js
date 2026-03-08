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
const PORT = process.env.PORT || 4000;
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
    '--proxy', 'socks5://127.0.0.1:40000',
    '--extractor-args', 'youtube:client=tv',
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
function runYtDlp(args, timeoutMs = 300000) {
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
app.get('/api/download', downloadLimiter, async (req, res) => {
    const { url, type, height, title } = req.query;
    if (!url || !type) return res.status(400).json({ error: 'url and type are required' });
    if (!isValidYouTubeURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });
    if (!acquireSlot()) return res.status(503).json({ error: 'Server busy. Please try again shortly.' });

    const safeTitle = (title || 'download')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ').trim().substring(0, 200) || 'download';

    const isAudio = type === 'audio';
    
    // 1. Give the file a unique ID, but let yt-dlp handle the extension dynamically
    const baseId = `dl_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    const tmpTemplate = path.join(os.tmpdir(), `${baseId}.%(ext)s`);

    let released = false;
    let finalFilePath = null;

    const cleanup = () => { 
        if (!released) { released = true; releaseSlot(); }
        
        // Clean up the main file
        if (finalFilePath && fs.existsSync(finalFilePath)) {
            fs.unlink(finalFilePath, () => {});
        }
        
        // Clean up any stray fragments yt-dlp might have left behind
        try {
            const files = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(baseId));
            for (const f of files) {
                fs.unlink(path.join(os.tmpdir(), f), () => {});
            }
        } catch(e) {}
    };
    res.on('close', cleanup);

    try {
        const h = parseInt(height, 10) || 720;
        
        // 2. Removed strict [ext=mp4]
        const format = isAudio 
            ? 'bestaudio' 
            : `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;

        const args = ['--quiet', '-f', format, '-o', tmpTemplate, url];

        if (isAudio) {
            args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
        } else {
            args.push('--merge-output-format', 'mp4'); // FFmpeg handle the webm to mp4 conversion
        }

        // 3. yt-dlp download and process
        await runYtDlp(args, 300000); 

        // 4. Find the actual finished file in the temp directory
        const tempFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(baseId));
        if (tempFiles.length === 0) {
            throw new Error("Download failed to create temporary file.");
        }
        
        finalFilePath = path.join(os.tmpdir(), tempFiles[0]);
        const stat = fs.statSync(finalFilePath);
        
        if (stat.size === 0) {
            throw new Error("File processing failed (0 bytes).");
        }

        // Get the final extension
        const ext = path.extname(finalFilePath).replace('.', '') || (isAudio ? 'mp3' : 'mp4');
        const filename = encodeURIComponent(`${safeTitle}.${ext}`);
        
        res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', stat.size); 

        const stream = fs.createReadStream(finalFilePath);
        stream.pipe(res);
        stream.on('end', cleanup);
        stream.on('error', cleanup);

    } catch (err) {
        cleanup();
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