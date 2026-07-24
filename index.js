const express = require('express');
const youtubedl = require('yt-dlp-exec');
const ytSearch = require('yt-search');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ==================== PC WORKER CONFIG ====================
const PC_WORKER_URL = process.env.PC_WORKER_URL || "";
let pcOnline = false;

// Check PC worker status every 30 seconds
setInterval(async () => {
    if (!PC_WORKER_URL) {
        pcOnline = false;
        return;
    }
    try {
        const response = await axios.get(`${PC_WORKER_URL}/health`, { 
            timeout: 5000,
            validateStatus: false
        });
        pcOnline = response.status === 200;
        if (pcOnline) {
            console.log("✅ PC Worker is ONLINE");
        } else {
            console.log("❌ PC Worker is OFFLINE");
        }
    } catch {
        pcOnline = false;
        console.log("❌ PC Worker is OFFLINE");
    }
}, 30000);

// Initial check
setTimeout(() => {
    if (PC_WORKER_URL) {
        axios.get(`${PC_WORKER_URL}/health`, { timeout: 5000 })
            .then(() => {
                pcOnline = true;
                console.log("✅ PC Worker is ONLINE");
            })
            .catch(() => {
                pcOnline = false;
                console.log("❌ PC Worker is OFFLINE");
            });
    } else {
        console.log("📡 PC Worker: Not configured");
    }
}, 1000);

// ==================== MIDDLEWARE ====================
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== FOLDERS ====================
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const TEMP_DIR = path.join(os.tmpdir(), 'youtube-downloader');

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ==================== HELPERS ====================
const sanitizeFileName = (name) => {
    return (name || 'video')
        .replace(/[<>:"/\\|?*;\x00-\x1F]/g, '')
        .replace(/[\u007F-\u009F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'video';
};

const createContentDisposition = (filename) => {
    const cleaned = filename
        .replace(/["]+/g, '')
        .replace(/\\+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const ascii = cleaned
        .replace(/[^\x00-\x7F]/g, '')
        .replace(/[\x00-\x1F\x7F]/g, '');

    const safeAscii = ascii || 'download';
    const utf8Encoded = encodeURIComponent(cleaned || 'download');

    return `attachment; filename="${safeAscii}"; filename*=UTF-8''${utf8Encoded}`;
};

const createDownloadFormat = (type, quality) => {
    if (type === 'audio') {
        if (quality === 'highest' || quality === 'highestaudio') {
            return 'bestaudio/best';
        }
        if (quality === 'lowest') {
            return 'worstaudio/worst';
        }
        return quality;
    }

    if (quality === 'highest') {
        return 'bestvideo+bestaudio/best';
    }
    if (quality === 'lowest') {
        return 'worstvideo/worst';
    }
    return quality;
};

// ==================== COOKIE HANDLING ====================
const getCookieFilePath = () => {
    const renderSecret = '/etc/secrets/youtube.com_cookies.txt';
    if (fs.existsSync(renderSecret)) {
        const tempCookie = path.join(TEMP_DIR, 'yt-dlp-cookies.txt');
        fs.copyFileSync(renderSecret, tempCookie);
        console.log('✅ Using copied Render Secret File');
        return tempCookie;
    }

    const localCookie = path.join(__dirname, 'youtube.com_cookies.txt');
    if (fs.existsSync(localCookie)) {
        console.log('✅ Using local cookie file');
        return localCookie;
    }

    const raw = process.env.YTDLP_COOKIES;
    if (!raw || !raw.trim()) {
        console.log('❌ No cookies found');
        return null;
    }

    if (fs.existsSync(raw.trim())) {
        return raw.trim();
    }

    const cookieFile = path.join(TEMP_DIR, 'yt-dlp-cookies.txt');
    fs.writeFileSync(cookieFile, raw.trim(), 'utf8');
    return cookieFile;
};

const getDefaultYtdlpFlags = () => {
    const baseFlags = {
        noWarnings: true,
        noPlaylist: true,
        noMtime: true,
        noCheckCertificate: true,
        preferFreeFormats: true,
        geoBypass: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        referer: 'https://www.youtube.com/',
        addHeader: 'Accept-Language: en-US,en;q=0.9',
    };

    const cookiesPath = getCookieFilePath();
    console.log('Cookie path:', cookiesPath);
    if (cookiesPath) {
        baseFlags.cookies = cookiesPath;
    }
    return baseFlags;
};

const formatYtdlpError = (error) => {
    const message = (error && error.message) || String(error || 'Unknown error');
    if (/cookies|sign in to confirm you're not a bot|not a bot/i.test(message)) {
        return 'YouTube blocked this request. This environment may need cookies or a different IP address to download this video.';
    }
    return message;
};

const getYtdlpInfo = async (url) => {
    return await youtubedl(url, {
        ...getDefaultYtdlpFlags(),
        dumpSingleJson: true,
        skipDownload: true,
    });
};

const createArchive = async () => {
    const archiver = await import('archiver');
    return archiver.default('zip', { zlib: { level: 9 } });
};

const streamYtdlpDownload = (url, type, quality, res) => {
    const flags = {
        ...getDefaultYtdlpFlags(),
        output: '-',
        format: createDownloadFormat(type, quality),
    };

    if (type === 'audio') {
        flags.extractAudio = true;
        flags.audioFormat = 'mp3';
        flags.audioQuality = 0;
    }

    const child = youtubedl.exec(url, flags, {
        stdout: 'pipe',
        stderr: 'pipe',
    });

    console.log('streamYtdlpDownload started', { url, type, quality });

    child.stdout.pipe(res);

    child.stderr.on('data', (chunk) => {
        const message = chunk.toString();
        if (message.trim()) {
            console.error('yt-dlp:', message.trim());
        }
    });

    const cleanup = () => {
        if (!child.killed) {
            child.kill('SIGKILL');
        }
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);
    return child;
};

const downloadToTempFile = async (url, type, quality) => {
    const info = await getYtdlpInfo(url);
    const title = sanitizeFileName(info.title || info.fulltitle || 'download');
    const extension = type === 'video' ? 'mp4' : 'mp3';
    const tempFilePath = path.join(TEMP_DIR, `${crypto.randomBytes(8).toString('hex')}.${extension}`);

    const flags = {
        ...getDefaultYtdlpFlags(),
        output: tempFilePath,
        format: createDownloadFormat(type, quality),
    };

    if (type === 'video') {
        flags.mergeOutputFormat = 'mp4';
    }
    if (type === 'audio') {
        flags.extractAudio = true;
        flags.audioFormat = 'mp3';
        flags.audioQuality = 0;
    }

    await youtubedl.exec(url, flags);
    return { path: tempFilePath, title, extension };
};

// ==================== SEARCH ====================
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: 'Query required' });
    }
    try {
        const result = await ytSearch(query);
        res.json(result.videos.slice(0, 20));
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== VIDEO INFO ====================
app.get('/info', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }
    try {
        const info = await getYtdlpInfo(url);
        res.json(info);
    } catch (err) {
        console.error('Info error:', err);
        res.status(500).json({ error: formatYtdlpError(err) });
    }
});

// ==================== DOWNLOAD SINGLE ====================
app.get('/download/single', async (req, res) => {
    const url = req.query.url;
    const type = req.query.type || 'video';
    const quality = req.query.quality || 'highest';

    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }

    // Try PC worker first if available
    if (pcOnline && PC_WORKER_URL) {
        console.log('🔄 Using PC worker for download:', { url, type, quality });
        try {
            const response = await axios({
                method: 'GET',
                url: `${PC_WORKER_URL}/download/single`,
                params: { url, type, quality },
                responseType: 'stream',
                timeout: 300000,
                validateStatus: (status) => status < 500
            });

            if (response.headers['content-disposition']) {
                res.setHeader('Content-Disposition', response.headers['content-disposition']);
            }
            if (response.headers['content-type']) {
                res.setHeader('Content-Type', response.headers['content-type']);
            }

            response.data.pipe(res);
            console.log('✅ PC worker download successful');
            return;
        } catch (error) {
            console.error('❌ PC worker download failed:', error.message);
        }
    }

    // Fallback: Local yt-dlp download
    console.log('⚠️ Using local yt-dlp for download (fallback)');
    try {
        const info = await getYtdlpInfo(url);
        const title = sanitizeFileName(info.title || info.fulltitle || 'video');
        const extension = type === 'video' ? 'mp4' : 'mp3';
        const filename = `${title}.${extension}`;

        res.setHeader('Content-Disposition', createContentDisposition(filename));
        res.setHeader('Content-Type', type === 'video' ? 'video/mp4' : 'audio/mpeg');

        if (req.method === 'HEAD') {
            return res.end();
        }

        await streamYtdlpDownload(url, type, quality, res);
        console.log('✅ Local download finished');
    } catch (err) {
        console.error('❌ Local download error:', err);
        const message = formatYtdlpError(err);
        if (!res.headersSent) {
            res.status(500).json({
                error: message || 'Download failed',
                fallback: !pcOnline ? 'PC worker offline' : 'PC worker unavailable'
            });
        } else if (!res.writableEnded) {
            res.end();
        }
    }
});

// ==================== DOWNLOAD BATCH ====================
app.post('/download/batch', async (req, res) => {
    const { urls, type = 'video', quality = 'highest' } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'No URLs provided' });
    }

    // Try PC worker first if available
    if (pcOnline && PC_WORKER_URL) {
        console.log('🔄 Using PC worker for batch download');
        try {
            const response = await axios({
                method: 'POST',
                url: `${PC_WORKER_URL}/download/batch`,
                data: { urls, type, quality },
                responseType: 'stream',
                timeout: 600000,
                validateStatus: (status) => status < 500
            });

            res.setHeader('Content-Disposition', response.headers['content-disposition'] || 'attachment; filename="videos.zip"');
            res.setHeader('Content-Type', response.headers['content-type'] || 'application/zip');

            response.data.pipe(res);
            console.log('✅ PC worker batch download successful');
            return;
        } catch (error) {
            console.error('❌ PC worker batch download failed:', error.message);
        }
    }

    // Fallback: Local batch download
    console.log('⚠️ Using local batch download (fallback)');
    const tempFiles = [];
    const zipFileName = `batch_${Date.now()}.zip`;
    const zipPath = path.join(TEMP_DIR, zipFileName);

    try {
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            try {
                const downloaded = await downloadToTempFile(url, type, quality);
                tempFiles.push({
                    path: downloaded.path,
                    name: `${i + 1}_${downloaded.title}.${downloaded.extension}`,
                });
            } catch (err) {
                console.error(`Failed to download ${url}`, err);
            }
        }

        if (tempFiles.length === 0) {
            return res.status(500).json({
                error: 'All downloads failed',
                fallback: !pcOnline ? 'PC worker offline' : 'PC worker unavailable'
            });
        }

        const output = fs.createWriteStream(zipPath);
        const archive = await createArchive();

        const archivePromise = new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
            archive.on('error', reject);
        });

        archive.pipe(output);
        tempFiles.forEach(file => {
            archive.file(file.path, { name: file.name });
        });

        await archive.finalize();
        await archivePromise;

        res.download(zipPath, zipFileName, (err) => {
            try {
                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
                tempFiles.forEach(file => {
                    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                });
            } catch (cleanupError) {
                console.error('Cleanup error:', cleanupError);
            }
            if (err) {
                console.error('ZIP send error:', err);
            }
        });

        console.log('✅ Local batch download finished');
    } catch (err) {
        console.error('Batch download error:', err);
        res.status(500).json({ error: formatYtdlpError(err) });
    }
});

// ==================== STATUS ENDPOINT ====================
app.get('/api/status', (req, res) => {
    res.json({
        pcOnline: pcOnline,
        pcWorkerConfigured: !!PC_WORKER_URL,
        downloadMode: pcOnline ? 'residential' : 'cloud',
        message: pcOnline ? 'Using residential IP for downloads' : 'Using cloud IP (may be blocked)',
        pcWorkerUrl: PC_WORKER_URL ? 'configured' : 'not configured'
    });
});

// ==================== TEST WORKER ENDPOINT ====================
app.get('/test-worker', async (req, res) => {
    if (!PC_WORKER_URL) {
        return res.json({ 
            pcOnline: false, 
            error: 'PC_WORKER_URL not configured' 
        });
    }
    
    try {
        const response = await axios.get(`${PC_WORKER_URL}/health`, { 
            timeout: 5000 
        });
        res.json({
            pcOnline: true,
            workerResponse: response.data
        });
    } catch (error) {
        res.json({
            pcOnline: false,
            error: error.message,
            pcWorkerUrl: PC_WORKER_URL
        });
    }
});

// ==================== SERVE FRONTEND ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
    const cookiePath = getCookieFilePath();
    res.json({
        status: 'ok',
        cookiesFound: !!cookiePath,
        cookiePath,
        pcWorkerAvailable: pcOnline,
        timestamp: new Date().toISOString()
    });
});

// ==================== YT-DLP VERSION ====================
const { execSync } = require('child_process');
app.get('/yt-version', (req, res) => {
    try {
        const version = execSync('./node_modules/yt-dlp-exec/bin/yt-dlp --version').toString();
        res.send(version);
    } catch (e) {
        res.status(500).send(e.toString());
    }
});

// ==================== START SERVER ====================
app.listen(PORT, HOST, () => {
    console.log(`🎬 YouTube Downloader Pro running on http://${HOST}:${PORT}`);
    console.log('Cookie file:', getCookieFilePath());
    console.log(`📡 PC Worker: ${PC_WORKER_URL ? 'Configured' : 'Not configured'}`);
    console.log(`📡 PC Worker Status: ${pcOnline ? '✅ Online' : '❌ Offline'}`);
});