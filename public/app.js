const form = document.querySelector("#videoForm");
const input = document.querySelector("#videoUrl");
const statusText = document.querySelector("#status");
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

  try {
    const response = await fetch("/api/formats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: currentUrl })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not load this video.");
    }

    thumbnail.src = data.thumbnail;
    thumbnail.alt = data.title;
    title.textContent = data.title;
    meta.textContent = [data.author, formatDuration(data.duration)].filter(Boolean).join(" · ");
    renderFormats(data.formats);
    result.classList.remove("hidden");
    setStatus("Choose a quality below.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});
