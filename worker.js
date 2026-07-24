const express = require("express");
const youtubedl = require("yt-dlp-exec");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());

// ==================== ROOT ROUTE ====================
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        message: "YouTube Downloader Worker is running",
        endpoints: ["/health", "/download/single", "/download/batch"],
        timestamp: new Date().toISOString()
    });
});

// ==================== FOLDERS ====================
const TEMP_DIR = path.join(os.tmpdir(), "yt-worker");
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ==================== COOKIE HANDLING ====================
const getCookieFilePath = () => {
    const localCookie = path.join(__dirname, "youtube.com_cookies.txt");
    if (fs.existsSync(localCookie)) {
        console.log("✅ Using cookie file");
        return localCookie;
    }
    console.log("❌ No cookies found");
    return null;
};

// ==================== HELPERS ====================
const sanitizeFileName = (name) => {
    return (name || "video")
        .replace(/[<>:"/\\|?*;\x00-\x1F]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
};

const getDefaultYtdlpFlags = () => {
    const flags = {
        noWarnings: true,
        noPlaylist: true,
        noMtime: true,
        noCheckCertificate: true,
        preferFreeFormats: true,
        geoBypass: true,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        referer: "https://www.youtube.com/",
        addHeader: "Accept-Language: en-US,en;q=0.9",
    };
    const cookies = getCookieFilePath();
    if (cookies) {
        flags.cookies = cookies;
    }
    return flags;
};

const createDownloadFormat = (type, quality) => {
    if (type === "audio") {
        if (quality === "highest" || quality === "highestaudio") return "bestaudio/best";
        if (quality === "lowest") return "worstaudio/worst";
        return quality;
    }
    if (quality === "highest") return "bestvideo+bestaudio/best";
    if (quality === "lowest") return "worstvideo/worst";
    return quality;
};

// ==================== HEALTH CHECK ====================
app.get("/health", (req, res) => {
    const cookiePath = getCookieFilePath();
    const cookiesExist = cookiePath && fs.existsSync(cookiePath);
    
    res.json({
        status: "ok",
        cookiesFound: cookiesExist,
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ==================== SINGLE DOWNLOAD ====================
app.get("/download/single", async (req, res) => {
    const { url, type = "video", quality = "highest" } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: "URL required" });
    }

    try {
        const info = await youtubedl(url, {
            ...getDefaultYtdlpFlags(),
            dumpSingleJson: true,
            skipDownload: true,
        });

        const title = sanitizeFileName(info.title || info.fulltitle || "video");
        const extension = type === "video" ? "mp4" : "mp3";
        const filename = `${title}.${extension}`;
        
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-Type", type === "video" ? "video/mp4" : "audio/mpeg");

        const flags = {
            ...getDefaultYtdlpFlags(),
            output: "-",
            format: createDownloadFormat(type, quality),
        };

        if (type === "audio") {
            flags.extractAudio = true;
            flags.audioFormat = "mp3";
            flags.audioQuality = 0;
        }

        const child = youtubedl.exec(url, flags, {
            stdout: "pipe",
            stderr: "pipe",
        });

        child.stdout.pipe(res);

        child.stderr.on("data", (chunk) => {
            const message = chunk.toString();
            if (message.trim()) {
                console.log("yt-dlp:", message.trim());
            }
        });

        const cleanup = () => {
            if (!child.killed) {
                child.kill("SIGKILL");
            }
        };

        res.on("close", cleanup);
        res.on("finish", cleanup);

    } catch (error) {
        console.error("Download error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || "Download failed" });
        }
    }
});

// ==================== BATCH DOWNLOAD ====================
app.post("/download/batch", async (req, res) => {
    const { urls, type = "video", quality = "highest" } = req.body;

    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: "No URLs provided" });
    }

    const archiver = (await import("archiver")).default;
    const tempFiles = [];

    try {
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            try {
                const info = await youtubedl(url, {
                    ...getDefaultYtdlpFlags(),
                    dumpSingleJson: true,
                    skipDownload: true,
                });

                const title = sanitizeFileName(info.title || info.fulltitle || `video_${i}`);
                const extension = type === "video" ? "mp4" : "mp3";
                const tempFilePath = path.join(TEMP_DIR, `${crypto.randomBytes(8).toString("hex")}.${extension}`);

                const flags = {
                    ...getDefaultYtdlpFlags(),
                    output: tempFilePath,
                    format: createDownloadFormat(type, quality),
                };

                if (type === "video") {
                    flags.mergeOutputFormat = "mp4";
                } else {
                    flags.extractAudio = true;
                    flags.audioFormat = "mp3";
                    flags.audioQuality = 0;
                }

                await youtubedl.exec(url, flags);

                tempFiles.push({
                    path: tempFilePath,
                    name: `${i + 1}_${title}.${extension}`
                });

            } catch (err) {
                console.error(`Failed to download ${url}:`, err.message);
            }
        }

        if (tempFiles.length === 0) {
            return res.status(500).json({ error: "All downloads failed" });
        }

        const zipFileName = `batch_${Date.now()}.zip`;
        const zipPath = path.join(TEMP_DIR, zipFileName);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 9 } });

        const archivePromise = new Promise((resolve, reject) => {
            output.on("close", resolve);
            output.on("error", reject);
            archive.on("error", reject);
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
                console.error("Cleanup error:", cleanupError);
            }
            if (err) {
                console.error("ZIP send error:", err);
            }
        });

    } catch (error) {
        console.error("Batch error:", error);
        res.status(500).json({ error: error.message || "Batch download failed" });
    }
});

// ==================== START SERVER ====================
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Worker running on port ${PORT}`);
    console.log(`🍪 Cookie: ${getCookieFilePath() ? "Found" : "Missing"}`);
    console.log(`🚀 Ready to process downloads!`);
});
