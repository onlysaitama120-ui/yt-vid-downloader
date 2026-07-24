const express = require('express');
const youtubedl = require('yt-dlp-exec');
const ytSearch = require('yt-search');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create downloads and temp folders
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const TEMP_DIR = path.join(os.tmpdir(), 'youtube-downloader');

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const sanitizeFileName = (name) => {
    return name
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

/*
|--------------------------------------------------------------------------
| COOKIE HANDLING (FIXED)
|--------------------------------------------------------------------------
*/

const getCookieFilePath = () => {

    // Render Secret File
    const renderSecret = '/etc/secrets/youtube.com_cookies.txt';

    if (fs.existsSync(renderSecret)) {

    const tempCookie = path.join(
        TEMP_DIR,
        'yt-dlp-cookies.txt'
    );

    fs.copyFileSync(renderSecret, tempCookie);

    console.log('✅ Using copied Render Secret File');

    return tempCookie;
}

    // Local cookie file
    const localCookie = path.join(__dirname, 'youtube.com_cookies.txt');

    if (fs.existsSync(localCookie)) {
        console.log('✅ Using local cookie file');
        return localCookie;
    }

    // Environment variable fallback
    const raw = process.env.YTDLP_COOKIES;

    if (!raw) {
        console.log('❌ No cookies found');
        return null;
    }

    const trimmed = raw.trim();

    if (!trimmed) {
        return null;
    }

    if (fs.existsSync(trimmed)) {
        return trimmed;
    }

    const cookieFile = path.join(
        TEMP_DIR,
        'yt-dlp-cookies.txt'
    );

    fs.writeFileSync(cookieFile, trimmed, 'utf8');

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

        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0 Safari/537.36',

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

    const message =
        (error && error.message) ||
        String(error || 'Unknown error');

    if (
        /cookies|sign in to confirm you're not a bot|not a bot/i.test(
            message
        )
    ) {
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
    const { ZipArchive } = await import('archiver');

    return new ZipArchive({
        zlib: { level: 9 },
    });
};
const streamYtdlpDownload = (url, type, quality, res) => {

    const format = createDownloadFormat(type, quality);

    const flags = {
        ...getDefaultYtdlpFlags(),
        output: '-',
        format,
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

    console.log('streamYtdlpDownload spawned child', {
        url,
        type,
        quality,
    });

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

const downloadToTempFile = async (
    url,
    type,
    quality
) => {

    const info = await getYtdlpInfo(url);

    const title = sanitizeFileName(
        info.title || info.fulltitle || 'download'
    );

    const extension =
        type === 'video' ? 'mp4' : 'mp3';

    const tempFilePath = path.join(
        TEMP_DIR,
        `${crypto.randomBytes(8).toString('hex')}.${extension}`
    );

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

    return {
        path: tempFilePath,
        title,
        extension,
    };
};

// ==================== SEARCH ====================

app.get('/search', async (req, res) => {

    const query = req.query.q;

    if (!query) {
        return res
            .status(400)
            .json({ error: 'Query required' });
    }

    try {

        const result = await ytSearch(query);

        res.json(result.videos.slice(0, 20));

    } catch (error) {

        console.error('Search error:', error);

        res.status(500).json({
            error: error.message,
        });

    }

});

// ==================== VIDEO INFO ====================

app.get('/info', async (req, res) => {

    const url = req.query.url;

    if (!url) {
        return res
            .status(400)
            .json({ error: 'URL required' });
    }

    try {

        const info = await getYtdlpInfo(url);

        const formats = info.formats || [];

        const videoFormats = formats.filter(
            (f) =>
                f.vcodec !== 'none' &&
                f.acodec !== 'none'
        );

        const videoQualities =
            videoFormats
                .map((f) => ({
                    quality:
                        f.format_note ||
                        f.qualityLabel ||
                        f.format ||
                        'Video',

                    itag: f.format_id,

                    container: f.ext,
                }))
                .filter(
                    (item, index, all) =>
                        index ===
                        all.findIndex(
                            (other) =>
                                other.itag === item.itag
                        )
                );

        const audioFormats = formats.filter(
            (f) =>
                f.vcodec === 'none' &&
                f.acodec !== 'none'
        );

        const audioQualities =
            audioFormats
                .map((f) => ({
                    quality: f.abr
                        ? `${f.abr}kbps`
                        : f.format || 'Audio',

                    itag: f.format_id,

                    container: f.ext,
                }))
                .filter(
                    (item, index, all) =>
                        index ===
                        all.findIndex(
                            (other) =>
                                other.itag === item.itag
                        )
                );

        res.json({

            title:
                info.title ||
                info.fulltitle ||
                'Untitled',

            channel:
                info.uploader ||
                info.channel ||
                '',

            thumbnail:
                info.thumbnail ||
                (
                    Array.isArray(info.thumbnails)
                        ? info.thumbnails.slice(-1)[0]?.url
                        : ''
                ),

            duration:
                info.duration || 0,

            videoQualities,

            audioQualities,

        });

    } catch (error) {

        console.error('Info error:', error);

        res.status(500).json({
            error: formatYtdlpError(error),
        });

    }

});
// ==================== DOWNLOAD SINGLE ====================

app.get('/download/single', async (req, res) => {

    const url = req.query.url;
    const type = req.query.type || 'video';
    const quality = req.query.quality || 'highest';

    if (!url) {
        return res
            .status(400)
            .json({ error: 'URL required' });
    }

    try {

        console.log('download/single start', {
            url,
            type,
            quality,
        });

        const info = await getYtdlpInfo(url);

        console.log('download/single got info', {
            title: info.title || info.fulltitle,
        });

        const title = sanitizeFileName(
            info.title ||
            info.fulltitle ||
            'video'
        );

        const extension =
            type === 'video'
                ? 'mp4'
                : 'mp3';

        const filename =
            `${title}.${extension}`;

        res.setHeader(
            'Content-Disposition',
            createContentDisposition(filename)
        );

        res.setHeader(
            'Content-Type',
            type === 'video'
                ? 'video/mp4'
                : 'audio/mpeg'
        );

        if (req.method === 'HEAD') {
            return res.end();
        }

        await streamYtdlpDownload(
            url,
            type,
            quality,
            res
        );

        console.log(
            'download/single finished streaming',
            {
                title,
                extension,
            }
        );

    } catch (error) {

        console.error(
            'Download error:',
            error
        );

        const message =
            formatYtdlpError(error);

        if (!res.headersSent) {

            res.status(500).json({
                error:
                    message ||
                    'Download failed',
            });

        } else {

            if (!res.writableEnded) {
                res.end();
            }

        }

    }

});

// ==================== DOWNLOAD BATCH ====================

app.post('/download/batch', async (req, res) => {

    const {
        urls,
        type,
        quality,
    } = req.body;

    if (!urls || urls.length === 0) {
        return res
            .status(400)
            .json({
                error:
                    'No URLs provided',
            });
    }

    const tempFiles = [];

    const zipFileName =
        `batch_${Date.now()}.zip`;

    const zipPath = path.join(
        TEMP_DIR,
        zipFileName
    );

    try {

        for (
            let i = 0;
            i < urls.length;
            i++
        ) {

            const url = urls[i];

            try {

                const info =
                    await getYtdlpInfo(url);

                const title =
                    sanitizeFileName(
                        info.title ||
                        info.fulltitle ||
                        `video_${i + 1}`
                    );

                const extension =
                    type === 'video'
                        ? 'mp4'
                        : 'mp3';

                const filename =
                    `${i + 1}_${title}.${extension}`;

                const tempFilePath =
                    path.join(
                        TEMP_DIR,
                        `${crypto.randomBytes(8).toString('hex')}_${filename}`
                    );

                const flags = {
                    ...getDefaultYtdlpFlags(),
                    output: tempFilePath,
                    format:
                        createDownloadFormat(
                            type,
                            quality
                        ),
                };

                if (type === 'audio') {

                    flags.extractAudio = true;
                    flags.audioFormat = 'mp3';
                    flags.audioQuality = 0;

                }

                await youtubedl.exec(
                    url,
                    flags
                );

                tempFiles.push({
                    path: tempFilePath,
                    name: filename,
                });

            } catch (err) {

                console.error(
                    `Error downloading ${url}:`,
                    err
                );

            }

        }
                const output = fs.createWriteStream(zipPath);
        const archive = await createArchive();

        const archivePromise = new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
            archive.on('error', reject);
        });

        archive.pipe(output);

        tempFiles.forEach((file) => {
            archive.file(file.path, {
                name: file.name,
            });
        });

        await archive.finalize();
        await archivePromise;

        res.download(zipPath, zipFileName, (err) => {

            try {

                if (fs.existsSync(zipPath)) {
                    fs.unlinkSync(zipPath);
                }

                tempFiles.forEach((file) => {

                    if (fs.existsSync(file.path)) {
                        fs.unlinkSync(file.path);
                    }

                });

            } catch (cleanupError) {

                console.error(
                    'Cleanup error:',
                    cleanupError
                );

            }

            if (err) {
                console.error(
                    'Batch download send error:',
                    err
                );
            }

        });

    } catch (error) {

        console.error(
            'Batch download error:',
            error
        );

        res.status(500).json({
            error:
                formatYtdlpError(error) ||
                'Batch download failed',
        });

    }

});

// ==================== SERVE FRONTEND ====================

app.get('/', (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            'public',
            'index.html'
        )
    );

});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {

    const cookiePath = getCookieFilePath();

    res.json({
        status: 'ok',
        cookiesFound: !!cookiePath,
        cookiePath,
    });

});

// ==================== START SERVER ====================
const { execSync } = require("child_process");

app.get("/yt-version", (req, res) => {
    try {
        const version = execSync("./node_modules/.bin/yt-dlp --version").toString();
        res.send(version);
    } catch (e) {
        res.status(500).send(e.toString());
    }
});

app.listen(PORT, HOST, () => {

    console.log(
        `🎬 YouTube Downloader Pro running on http://${HOST}:${PORT}`
    );

    console.log(
        'Cookie file:',
        getCookieFilePath()
    );

});