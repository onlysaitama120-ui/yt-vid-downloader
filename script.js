const express = require('express');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create downloads folder
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR);
}

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
        const info = await ytdl.getInfo(url);
        
        // Video formats (with video + audio)
        const videoFormats = info.formats.filter(f => f.hasVideo && f.hasAudio);
        const videoQualities = videoFormats.map(f => ({
            quality: f.qualityLabel || f.quality,
            itag: f.itag,
            container: f.container
        }));

        // Audio formats
        const audioFormats = info.formats.filter(f => f.hasAudio && !f.hasVideo);
        const audioQualities = audioFormats.map(f => ({
            quality: f.audioBitrate ? `${f.audioBitrate}kbps` : 'Audio',
            itag: f.itag,
            container: f.container
        }));

        res.json({
            title: info.videoDetails.title,
            thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1]?.url || '',
            duration: info.videoDetails.lengthSeconds,
            videoQualities: videoQualities,
            audioQualities: audioQualities
        });
    } catch (error) {
        console.error('Info error:', error);
        res.status(500).json({ error: error.message });
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

    try {
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
        const extension = type === 'video' ? 'mp4' : 'mp3';

        res.header('Content-Disposition', `attachment; filename="${title}.${extension}"`);
        res.header('Content-Type', type === 'video' ? 'video/mp4' : 'audio/mpeg');

        const options = {
            quality: quality,
            filter: type === 'video' ? 'audioandvideo' : 'audioonly'
        };

        ytdl(url, options).pipe(res);
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== DOWNLOAD BATCH ====================
app.post('/download/batch', async (req, res) => {
    const { urls, type, quality } = req.body;

    if (!urls || urls.length === 0) {
        return res.status(400).json({ error: 'No URLs provided' });
    }

    try {
        const zipFileName = `batch_${Date.now()}.zip`;
        const zipPath = path.join(DOWNLOAD_DIR, zipFileName);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            res.download(zipPath, zipFileName, (err) => {
                fs.unlinkSync(zipPath);
                if (err) console.error('Download error:', err);
            });
        });

        archive.pipe(output);

        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            try {
                const info = await ytdl.getInfo(url);
                const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
                const extension = type === 'video' ? 'mp4' : 'mp3';
                const filename = `${i+1}_${title}.${extension}`;

                const stream = ytdl(url, {
                    quality: quality || 'highest',
                    filter: type === 'video' ? 'audioandvideo' : 'audioonly'
                });

                archive.append(stream, { name: filename });
            } catch (err) {
                console.error(`Error downloading ${url}:`, err);
            }
        }

        await archive.finalize();
    } catch (error) {
        console.error('Batch download error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== SERVE FRONTEND ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`🎬 YouTube Downloader Pro running on http://localhost:${PORT}`);
});