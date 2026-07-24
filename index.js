const express = require('express');
const ytSearch = require('yt-search');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ==================== PC WORKER CONFIG ====================
const PC_WORKER_URL = process.env.PC_WORKER_URL || "";
const WORKER_SECRET = process.env.WORKER_SECRET || "";
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
            validateStatus: false,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {}
        });
        pcOnline = response.status === 200;
        console.log(`📡 PC Worker: ${pcOnline ? '✅ ONLINE' : '❌ OFFLINE'}`);
    } catch {
        pcOnline = false;
        console.log('📡 PC Worker: ❌ OFFLINE');
    }
}, 30000);

// Initial check
setTimeout(async () => {
    if (!PC_WORKER_URL) {
        console.log('📡 PC Worker: Not configured');
        return;
    }
    try {
        const response = await axios.get(`${PC_WORKER_URL}/health`, {
            timeout: 5000,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {}
        });
        pcOnline = response.status === 200;
        console.log(`📡 PC Worker: ${pcOnline ? '✅ ONLINE' : '❌ OFFLINE'}`);
    } catch {
        pcOnline = false;
        console.log('📡 PC Worker: ❌ OFFLINE');
    }
}, 1000);

// ==================== MIDDLEWARE ====================
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// ==================== PROXY: INFO ====================
app.get('/info', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }

    if (!PC_WORKER_URL) {
        return res.status(503).json({ error: 'PC Worker not configured' });
    }

    if (!pcOnline) {
        return res.status(503).json({ error: 'PC Worker offline' });
    }

    try {
        const response = await axios.get(`${PC_WORKER_URL}/info`, {
            params: { url },
            timeout: 15000,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {}
        });
        res.json(response.data);
    } catch (error) {
        console.error('Worker info failed:', error.message);
        res.status(500).json({
            error: 'PC Worker failed to get video info',
            details: error.message
        });
    }
});

// ==================== PROXY: DOWNLOAD SINGLE ====================
app.get('/download/single', async (req, res) => {
    const { url, type = 'video', quality = 'highest' } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }

    if (!PC_WORKER_URL) {
        return res.status(503).json({ error: 'PC Worker not configured' });
    }

    if (!pcOnline) {
        return res.status(503).json({ error: 'PC Worker offline' });
    }

    try {
        const response = await axios({
            method: 'GET',
            url: `${PC_WORKER_URL}/download/single`,
            params: { url, type, quality },
            responseType: 'stream',
            timeout: 300000,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {},
            validateStatus: (status) => status < 500
        });

        if (response.headers['content-disposition']) {
            res.setHeader('Content-Disposition', response.headers['content-disposition']);
        }
        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }

        response.data.pipe(res);
    } catch (error) {
        console.error('Worker download failed:', error.message);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'PC Worker download failed',
                details: error.message
            });
        }
    }
});

// ==================== PROXY: BATCH DOWNLOAD ====================
app.post('/download/batch', async (req, res) => {
    const { urls, type = 'video', quality = 'highest' } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'No URLs provided' });
    }

    if (!PC_WORKER_URL) {
        return res.status(503).json({ error: 'PC Worker not configured' });
    }

    if (!pcOnline) {
        return res.status(503).json({ error: 'PC Worker offline' });
    }

    try {
        const response = await axios({
            method: 'POST',
            url: `${PC_WORKER_URL}/download/batch`,
            data: { urls, type, quality },
            responseType: 'stream',
            timeout: 600000,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {},
            validateStatus: (status) => status < 500
        });

        res.setHeader('Content-Disposition', response.headers['content-disposition'] || 'attachment; filename="videos.zip"');
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/zip');

        response.data.pipe(res);
    } catch (error) {
        console.error('Worker batch failed:', error.message);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'PC Worker batch download failed',
                details: error.message
            });
        }
    }
});

// ==================== STATUS ====================
app.get('/api/status', (req, res) => {
    res.json({
        pcOnline,
        pcWorkerConfigured: !!PC_WORKER_URL,
        downloadMode: pcOnline ? 'residential' : 'offline',
        message: pcOnline ? 'Using residential IP for downloads' : 'PC Worker offline',
        workerSecretConfigured: !!WORKER_SECRET
    });
});

// ==================== TEST WORKER ====================
app.get('/test-worker', async (req, res) => {
    if (!PC_WORKER_URL) {
        return res.json({ pcOnline: false, error: 'PC_WORKER_URL not configured' });
    }

    try {
        const response = await axios.get(`${PC_WORKER_URL}/health`, {
            timeout: 5000,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {}
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

// ==================== FRONTEND ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== HEALTH ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        pcWorkerAvailable: pcOnline,
        timestamp: new Date().toISOString()
    });
});

// ==================== START ====================
app.listen(PORT, HOST, () => {
    console.log(`🎬 YouTube Downloader Pro running on http://${HOST}:${PORT}`);
    console.log(`📡 PC Worker: ${PC_WORKER_URL ? 'Configured' : 'Not configured'}`);
    console.log(`📡 PC Worker Status: ${pcOnline ? '✅ ONLINE' : '❌ OFFLINE'}`);
    console.log(`🔒 Worker Secret: ${WORKER_SECRET ? '✅ Set' : '❌ Not set'}`);
});const express = require('express');
const ytSearch = require('yt-search');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ==================== PC WORKER CONFIG ====================
const PC_WORKER_URL = process.env.PC_WORKER_URL || "";
const WORKER_SECRET = process.env.WORKER_SECRET || "";
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
            validateStatus: false,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {}
        });
        pcOnline = response.status === 200;
        console.log(`📡 PC Worker: ${pcOnline ? '✅ ONLINE' : '❌ OFFLINE'}`);
    } catch {
        pcOnline = false;
        console.log('📡 PC Worker: ❌ OFFLINE');
    }
}, 30000);

// Initial check
setTimeout(async () => {
    if (!PC_WORKER_URL) {
        console.log('📡 PC Worker: Not configured');
        return;
    }
    try {
        const response = await axios.get(`${PC_WORKER_URL}/health`, {
            timeout: 5000,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {}
        });
        pcOnline = response.status === 200;
        console.log(`📡 PC Worker: ${pcOnline ? '✅ ONLINE' : '❌ OFFLINE'}`);
    } catch {
        pcOnline = false;
        console.log('📡 PC Worker: ❌ OFFLINE');
    }
}, 1000);

// ==================== MIDDLEWARE ====================
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// ==================== PROXY: INFO ====================
app.get('/info', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }

    if (!PC_WORKER_URL) {
        return res.status(503).json({ error: 'PC Worker not configured' });
    }

    if (!pcOnline) {
        return res.status(503).json({ error: 'PC Worker offline' });
    }

    try {
        const response = await axios.get(`${PC_WORKER_URL}/info`, {
            params: { url },
            timeout: 15000,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {}
        });
        res.json(response.data);
    } catch (error) {
        console.error('Worker info failed:', error.message);
        res.status(500).json({
            error: 'PC Worker failed to get video info',
            details: error.message
        });
    }
});

// ==================== PROXY: DOWNLOAD SINGLE ====================
app.get('/download/single', async (req, res) => {
    const { url, type = 'video', quality = 'highest' } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }

    if (!PC_WORKER_URL) {
        return res.status(503).json({ error: 'PC Worker not configured' });
    }

    if (!pcOnline) {
        return res.status(503).json({ error: 'PC Worker offline' });
    }

    try {
        const response = await axios({
            method: 'GET',
            url: `${PC_WORKER_URL}/download/single`,
            params: { url, type, quality },
            responseType: 'stream',
            timeout: 300000,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {},
            validateStatus: (status) => status < 500
        });

        if (response.headers['content-disposition']) {
            res.setHeader('Content-Disposition', response.headers['content-disposition']);
        }
        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }

        response.data.pipe(res);
    } catch (error) {
        console.error('Worker download failed:', error.message);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'PC Worker download failed',
                details: error.message
            });
        }
    }
});

// ==================== PROXY: BATCH DOWNLOAD ====================
app.post('/download/batch', async (req, res) => {
    const { urls, type = 'video', quality = 'highest' } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'No URLs provided' });
    }

    if (!PC_WORKER_URL) {
        return res.status(503).json({ error: 'PC Worker not configured' });
    }

    if (!pcOnline) {
        return res.status(503).json({ error: 'PC Worker offline' });
    }

    try {
        const response = await axios({
            method: 'POST',
            url: `${PC_WORKER_URL}/download/batch`,
            data: { urls, type, quality },
            responseType: 'stream',
            timeout: 600000,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {},
            validateStatus: (status) => status < 500
        });

        res.setHeader('Content-Disposition', response.headers['content-disposition'] || 'attachment; filename="videos.zip"');
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/zip');

        response.data.pipe(res);
    } catch (error) {
        console.error('Worker batch failed:', error.message);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'PC Worker batch download failed',
                details: error.message
            });
        }
    }
});

// ==================== STATUS ====================
app.get('/api/status', (req, res) => {
    res.json({
        pcOnline,
        pcWorkerConfigured: !!PC_WORKER_URL,
        downloadMode: pcOnline ? 'residential' : 'offline',
        message: pcOnline ? 'Using residential IP for downloads' : 'PC Worker offline',
        workerSecretConfigured: !!WORKER_SECRET
    });
});

// ==================== TEST WORKER ====================
app.get('/test-worker', async (req, res) => {
    if (!PC_WORKER_URL) {
        return res.json({ pcOnline: false, error: 'PC_WORKER_URL not configured' });
    }

    try {
        const response = await axios.get(`${PC_WORKER_URL}/health`, {
            timeout: 5000,
            headers: WORKER_SECRET ? { 'Authorization': `Bearer ${WORKER_SECRET}` } : {}
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

// ==================== FRONTEND ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== HEALTH ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        pcWorkerAvailable: pcOnline,
        timestamp: new Date().toISOString()
    });
});

// ==================== START ====================
app.listen(PORT, HOST, () => {
    console.log(`🎬 YouTube Downloader Pro running on http://${HOST}:${PORT}`);
    console.log(`📡 PC Worker: ${PC_WORKER_URL ? 'Configured' : 'Not configured'}`);
    console.log(`📡 PC Worker Status: ${pcOnline ? '✅ ONLINE' : '❌ OFFLINE'}`);
    console.log(`🔒 Worker Secret: ${WORKER_SECRET ? '✅ Set' : '❌ Not set'}`);
});