import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

const log = (level, event, details = {}) => {
  const payload = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...details
  };

  const output = JSON.stringify(payload);
  if (level === "error") {
    console.error(output);
  } else {
    console.log(output);
  }

  return payload;
};

function createResponseLogger() {
  const logs = [];

  return {
    logs,
    write(level, event, details = {}) {
      const entry = log(level, event, details);
      logs.push(entry);
      return entry;
    }
  };
}

function createRequestContext(req) {
  return {
    requestId: randomUUID().slice(0, 8),
    method: req.method,
    path: req.path,
    userAgent: req.get("user-agent") || "",
    renderService: process.env.RENDER_SERVICE_NAME || "",
    renderInstance: process.env.RENDER_INSTANCE_ID || ""
  };
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack,
    stderr: error?.stderr,
    stdout: error?.stdout,
    code: error?.code,
    signal: error?.signal
  };
}

function getClientErrorMessage(error, fallback) {
  const raw = [error?.stderr, error?.message, String(error || "")]
    .filter(Boolean)
    .join("\n");

  if (/sign in to confirm|not a bot|cookies|captcha|confirm you'?re not a bot/i.test(raw)) {
    return "YouTube is blocking this server request. Render free-tier/datacenter IPs are often challenged by YouTube.";
  }

  if (/private video|members-only|unavailable|video unavailable/i.test(raw)) {
    return "This video is unavailable to the server. Try a public video link.";
  }

  if (/timed out|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|network/i.test(raw)) {
    return "The server could not reach YouTube reliably. Try again after the Render service is awake.";
  }

  return fallback;
}

function sendJsonError(res, status, requestId, message, detail, logs = []) {
  res.status(status).json({
    error: message,
    requestId,
    detail,
    logs
  });
}

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
  const context = createRequestContext(req);
  const responseLogger = createResponseLogger();
  const url = req.body?.url?.trim();

  res.setHeader("x-request-id", context.requestId);

  if (!isValidYouTubeUrl(url)) {
    responseLogger.write("warn", "formats.invalid_url", context);
    return sendJsonError(
      res,
      400,
      context.requestId,
      "Paste a valid YouTube video link.",
      undefined,
      responseLogger.logs
    );
  }

  try {
    responseLogger.write("info", "formats.start", { ...context, url });
    await assertBinaryExists(ytdlpPath, "yt-dlp");
    const info = await getVideoInfo(url);
    const availableFormats = getDownloadableFormats(info).map(mapFormat);

    responseLogger.write("info", "formats.success", {
      ...context,
      title: info.title,
      duration: Number(info.duration || 0),
      formats: availableFormats.length
    });

    res.json({
      title: info.title,
      author: info.uploader || info.channel || "YouTube",
      thumbnail: info.thumbnail || info.thumbnails?.at(-1)?.url || "",
      duration: Number(info.duration || 0),
      formats: availableFormats,
      requestId: context.requestId,
      logs: responseLogger.logs
    });
  } catch (error) {
    const message = getClientErrorMessage(
      error,
      "Could not load video qualities. Try another public YouTube link."
    );

    responseLogger.write("error", "formats.failure", {
      ...context,
      url,
      error: serializeError(error)
    });

    sendJsonError(res, 500, context.requestId, message, undefined, responseLogger.logs);
  }
});

app.get("/download", async (req, res) => {
  const context = createRequestContext(req);
  const responseLogger = createResponseLogger();
  const url = String(req.query.url || "").trim();
  const formatId = String(req.query.format || "");
  const wantsJson = req.accepts(["json", "html", "text"]) === "json";

  res.setHeader("x-request-id", context.requestId);

  if (!isValidYouTubeUrl(url) || !formatId) {
    responseLogger.write("warn", "download.invalid_request", context);
    if (wantsJson) {
      return sendJsonError(
        res,
        400,
        context.requestId,
        "Invalid download request.",
        undefined,
        responseLogger.logs
      );
    }
    return res.status(400).send(`Invalid download request. Request id: ${context.requestId}`);
  }

  try {
    responseLogger.write("info", "download.start", { ...context, url, formatId });
    await assertBinaryExists(ytdlpPath, "yt-dlp");
    await assertBinaryExists(ffmpegBinaryPath, "ffmpeg");
    const info = await getVideoInfo(url);
    const format = getDownloadableFormats(info).find((item) => item.format_id === formatId);

    if (!format) {
      responseLogger.write("warn", "download.format_missing", { ...context, url, formatId });
      if (wantsJson) {
        return sendJsonError(
          res,
          404,
          context.requestId,
          "That quality is not available anymore.",
          undefined,
          responseLogger.logs
        );
      }
      return res.status(404).send(`That quality is not available anymore. Request id: ${context.requestId}`);
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
    let stderr = "";
    let stdout = "";

    download.stdout.on("data", (data) => {
      stdout += String(data);
    });
    download.stderr.on("data", (data) => {
      stderr += String(data);
    });
    download.on("error", async (error) => {
      await fs.rm(tempDir, { recursive: true, force: true });
      responseLogger.write("error", "download.spawn_error", {
        ...context,
        url,
        formatId,
        error: serializeError(error),
        stderr,
        stdout
      });
      if (!res.headersSent) {
        const message = getClientErrorMessage(error, "Download failed.");
        if (wantsJson) {
          sendJsonError(res, 500, context.requestId, message, undefined, responseLogger.logs);
        } else {
          res.status(500).send(`${message} Request id: ${context.requestId}`);
        }
      }
    });
    download.on("close", async (code) => {
      if (code !== 0) {
        await fs.rm(tempDir, { recursive: true, force: true });
        const error = new Error(`yt-dlp exited with code ${code}`);
        error.stderr = stderr;
        error.stdout = stdout;

        responseLogger.write("error", "download.process_failed", {
          ...context,
          url,
          formatId,
          exitCode: code,
          stderr,
          stdout
        });

        if (!res.headersSent) {
          const message = getClientErrorMessage(error, "Download failed.");
          if (wantsJson) {
            sendJsonError(res, 500, context.requestId, message, undefined, responseLogger.logs);
          } else {
            res.status(500).send(`${message} Request id: ${context.requestId}`);
          }
        }
        return;
      }

      const files = await fs.readdir(tempDir);
      const file = files.find((item) => item.startsWith("video."));

      if (!file) {
        await fs.rm(tempDir, { recursive: true, force: true });
        responseLogger.write("error", "download.output_missing", {
          ...context,
          url,
          formatId,
          stderr,
          stdout,
          files
        });
        if (!res.headersSent) {
          if (wantsJson) {
            sendJsonError(res, 500, context.requestId, "Download failed.", undefined, responseLogger.logs);
          } else {
            res.status(500).send(`Download failed. Request id: ${context.requestId}`);
          }
        }
        return;
      }

      const filePath = path.join(tempDir, file);
      const filename = `${title}.${path.extname(file).slice(1) || extension}`;
      responseLogger.write("info", "download.success", {
        ...context,
        url,
        formatId,
        filename
      });
      res.download(filePath, filename, async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        if (error) {
          responseLogger.write("error", "download.response_error", {
            ...context,
            url,
            formatId,
            error: serializeError(error)
          });
        }
      });
    });
  } catch (error) {
    const message = getClientErrorMessage(
      error,
      "Download failed. Try refreshing the qualities and downloading again."
    );

    responseLogger.write("error", "download.failure", {
      ...context,
      url,
      formatId,
      error: serializeError(error)
    });

    if (wantsJson) {
      sendJsonError(res, 500, context.requestId, message, undefined, responseLogger.logs);
    } else {
      res.status(500).send(`${message} Request id: ${context.requestId}`);
    }
  }
});

const server = app.listen(port, host, () => {
  console.log(`YouTube downloader running at http://${host}:${port}`);
  log("info", "server.started", {
    port,
    host,
    node: process.version,
    platform: process.platform,
    ytdlpPath,
    ffmpegBinaryPath,
    renderService: process.env.RENDER_SERVICE_NAME || "",
    renderInstance: process.env.RENDER_INSTANCE_ID || ""
  });
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
