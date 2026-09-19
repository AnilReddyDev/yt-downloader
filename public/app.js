const form = document.querySelector("#videoForm");
const input = document.querySelector("#videoUrl");
const statusText = document.querySelector("#status");
const logs = document.querySelector("#logs");
const result = document.querySelector("#result");
const thumbnail = document.querySelector("#thumbnail");
const title = document.querySelector("#title");
const meta = document.querySelector("#meta");
const formats = document.querySelector("#formats");
const submitButton = form.querySelector("button");

let currentUrl = "";

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", isError);
}

function renderLogs(items = []) {
  logs.textContent = items.length
    ? items.map((item) => JSON.stringify(item, null, 2)).join("\n\n")
    : "";
  logs.classList.toggle("hidden", !items.length);
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  const parts = date.toISOString().slice(11, 19).split(":");
  return seconds >= 3600 ? parts.join(":") : parts.slice(1).join(":");
}

function formatBytes(bytes) {
  const size = Number(bytes);
  if (!size) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function getFilenameFromDisposition(disposition) {
  const utf8Match = disposition?.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1]);

  const asciiMatch = disposition?.match(/filename="?([^"]+)"?/i);
  return asciiMatch?.[1] || "youtube-download.mp4";
}

async function readErrorResponse(response) {
  const requestId = response.headers.get("x-request-id");

  try {
    const data = await response.clone().json();
    const suffix = data.requestId || requestId ? ` Error log id: ${data.requestId || requestId}` : "";
    renderLogs(data.logs);
    return `${data.error || "Download failed."}${suffix}`;
  } catch {
    const message = await response.text();
    const suffix = requestId ? ` Error log id: ${requestId}` : "";
    renderLogs();
    return `${message || "Download failed."}${suffix}`;
  }
}

async function downloadFormat(event) {
  event.preventDefault();

  const link = event.currentTarget;
  const originalText = link.textContent;

  link.classList.add("disabled");
  link.textContent = "Preparing...";
  setStatus("Preparing download...");
  renderLogs();

  try {
    const response = await fetch(link.href, {
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(await readErrorResponse(response));
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const temporaryLink = document.createElement("a");

    temporaryLink.href = objectUrl;
    temporaryLink.download = getFilenameFromDisposition(response.headers.get("content-disposition"));
    document.body.append(temporaryLink);
    temporaryLink.click();
    temporaryLink.remove();
    URL.revokeObjectURL(objectUrl);

    setStatus("Download started.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    link.classList.remove("disabled");
    link.textContent = originalText;
  }
}

function renderFormats(items) {
  formats.innerHTML = "";

  if (!items.length) {
    formats.innerHTML = "<p>No downloadable formats found for this video.</p>";
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("article");
    row.className = "format";

    const detail = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = item.label;

    const sub = document.createElement("span");
    const fileSize = formatBytes(item.contentLength);
    sub.textContent = fileSize ? `Estimated size: ${fileSize}` : "Size shown by YouTube may be unavailable";

    const link = document.createElement("a");
    link.className = "download";
    link.textContent = "Download";
    link.href = `/download?url=${encodeURIComponent(currentUrl)}&format=${encodeURIComponent(item.id)}`;
    link.addEventListener("click", downloadFormat);

    detail.append(heading, sub);
    row.append(detail, link);
    formats.append(row);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  currentUrl = input.value.trim();

  result.classList.add("hidden");
  formats.innerHTML = "";
  submitButton.disabled = true;
  setStatus("Loading available qualities...");
  renderLogs();

  try {
    const response = await fetch("/api/formats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: currentUrl })
    });
    const data = await response.json();

    if (!response.ok) {
      renderLogs(data.logs);
      const suffix = data.requestId ? ` Error log id: ${data.requestId}` : "";
      throw new Error(`${data.error || "Could not load this video."}${suffix}`);
    }

    thumbnail.src = data.thumbnail;
    thumbnail.alt = data.title;
    title.textContent = data.title;
    meta.textContent = [data.author, formatDuration(data.duration)].filter(Boolean).join(" · ");
    renderFormats(data.formats);
    result.classList.remove("hidden");
    renderLogs(data.logs);
    setStatus("Choose a quality below.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});
