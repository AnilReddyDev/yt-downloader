import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import ffmpegPath from "ffmpeg-static";
import youtubedl from "youtube-dl-exec";

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || "0.0.0.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ytdlpPath = path.join(
  __dirname,
  "node_modules",
  "youtube-dl-exec",
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);
const ffmpegBinaryPath = ffmpegPath || "";

app.use(express.json());
app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.send("ok");
});

function isValidYouTubeUrl(url) {
  if (typeof url !== "string") return false;

  try {
    const parsed = new URL(url.trim());
    const hostName = parsed.hostname.replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"].includes(hostName);
  } catch {
    return false;
  }
}

function cleanTitle(title) {
  return (title || "youtube-video")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "youtube-video";
}

function makeFormatLabel(format) {
  const quality = format.height ? `${format.height}p` : format.qualityLabel || "Audio";
  const fps = format.fps ? ` ${format.fps}fps` : "";
  const type = format.hasVideo ? "video + audio" : "audio only";
  const container = format.ext ? format.ext.toUpperCase() : "MEDIA";
  return `${quality}${fps} · ${container} · ${type}`;
}

function mapFormat(format) {
  return {
    id: format.format_id,
    label: makeFormatLabel(format),
    qualityLabel: format.height ? `${format.height}p` : format.qualityLabel || null,
    ext: format.ext || "",
    hasAudio: format.hasAudio,
    hasVideo: format.hasVideo,
    bitrate: format.tbr || format.abr || null,
    contentLength: format.contentLength || null
  };
}

function getDownloadableFormats(info) {
  const formats = info.formats || [];
  const heights = [...new Set(
    formats
      .filter((format) => format.vcodec !== "none" && format.height)
      .map((format) => format.height)
  )].sort((a, b) => b - a);

  const videoFormats = heights.map((height) => {
    const candidates = formats.filter((format) => format.vcodec !== "none" && format.height === height);
    const size = candidates.find((format) => format.filesize || format.filesize_approx);

    return {
      format_id: `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`,
      height,
      fps: Math.max(...candidates.map((format) => format.fps || 0)) || null,
      ext: "mp4",
      hasAudio: true,
      hasVideo: true,
      contentLength: size?.filesize || size?.filesize_approx || null
    };
  });

  const audioFormats = formats
    .filter((format) => format.format_id && format.vcodec === "none" && format.acodec !== "none")
    .filter((format, index, audio) => {
      const key = `${format.ext}-${format.format_note || format.abr}`;
      return audio.findIndex((item) => `${item.ext}-${item.format_note || item.abr}` === key) === index;
    })
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))
    .slice(0, 4)
    .map((format) => ({
      format_id: format.format_id,
      qualityLabel: format.format_note || `${Math.round(format.abr || 0)}kbps`,
      ext: format.ext || "m4a",
      hasAudio: true,
      hasVideo: false,
      abr: format.abr,
      contentLength: format.filesize || format.filesize_approx || null
    }));

  return [...videoFormats, ...audioFormats];
}

async function getVideoInfo(url) {
  return youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noPlaylist: true
  });
}

async function assertBinaryExists(filePath, name) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`${name} is missing. Run npm install again, then restart the app.`);
  }
}

app.post("/api/formats", async (req, res) => {
  const url = req.body?.url?.trim();

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: "Paste a valid YouTube video link." });
  }

  try {
    await assertBinaryExists(ytdlpPath, "yt-dlp");
    const info = await getVideoInfo(url);

    res.json({
      title: info.title,
      author: info.uploader || info.channel || "YouTube",
      thumbnail: info.thumbnail || info.thumbnails?.at(-1)?.url || "",
      duration: Number(info.duration || 0),
      formats: getDownloadableFormats(info).map(mapFormat)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Could not load video qualities. Try another public YouTube link."
    });
  }
});

app.get("/download", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const formatId = String(req.query.format || "");

  if (!isValidYouTubeUrl(url) || !formatId) {
    return res.status(400).send("Invalid download request.");
  }

  try {
    await assertBinaryExists(ytdlpPath, "yt-dlp");
    await assertBinaryExists(ffmpegBinaryPath, "ffmpeg");
    const info = await getVideoInfo(url);
    const format = getDownloadableFormats(info).find((item) => item.format_id === formatId);

    if (!format) {
      return res.status(404).send("That quality is not available anymore.");
    }

    const title = cleanTitle(info.title);
    const extension = format.ext || "mp4";
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-download-"));
    const outputTemplate = path.join(tempDir, "video.%(ext)s");
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--ffmpeg-location",
      ffmpegBinaryPath,
      "-f",
      formatId,
      "-o",
      outputTemplate,
      url
    ];

    if (format.hasVideo) {
      args.splice(4, 0, "--merge-output-format", "mp4");
    }

    const download = spawn(ytdlpPath, args);

    download.stderr.on("data", (data) => console.error(String(data)));
    download.on("error", async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
      if (!res.headersSent) res.status(500).send("Download failed.");
    });
    download.on("close", async (code) => {
      if (code !== 0) {
        await fs.rm(tempDir, { recursive: true, force: true });
        if (!res.headersSent) res.status(500).send("Download failed.");
        return;
      }

      const files = await fs.readdir(tempDir);
      const file = files.find((item) => item.startsWith("video."));

      if (!file) {
        await fs.rm(tempDir, { recursive: true, force: true });
        if (!res.headersSent) res.status(500).send("Download failed.");
        return;
      }

      const filePath = path.join(tempDir, file);
      res.download(filePath, `${title}.${path.extname(file).slice(1) || extension}`, async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      });
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Download failed. Try refreshing the qualities and downloading again.");
  }
});

const server = app.listen(port, host, () => {
  console.log(`YouTube downloader running at http://${host}:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Try: PORT=3001 npm start`);
  } else if (error.code === "EPERM" || error.code === "EACCES") {
    console.error(`Could not open ${host}:${port}. Try another port: PORT=3001 npm start`);
  } else {
    console.error(error);
  }

  process.exit(1);
});
