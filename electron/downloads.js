"use strict";

// Native video downloads for the Windows shell.
//
// The site view runs in its own persistent session. We watch that session's
// requests for HLS playlists and direct video files, then download the bytes
// with the same cookies/referrer. HLS is remuxed to MP4 with the bundled
// FFmpeg binary; no page scripts or remote services are involved.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { app, net, shell } = require("electron");

const MAX_MEDIA = 40;
const MAX_JOBS = 20;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const MAX_SNIFF_BYTES = 4 * 1024 * 1024;
const MAX_SNIFF_RESPONSES = 40;
const ACTIVE_STATES = new Set(["checking", "downloading", "processing"]);
const CAPTURED_HEADERS = new Set(["authorization", "referer", "origin", "user-agent"]);
const SNIFFABLE_MIME_TYPES = new Set([
  "",
  "text/plain",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/x-binary"
]);
const GENERIC_BINARY_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/x-binary"
]);

function cleanText(value, maxLength) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, maxLength || 200);
}

function hostOf(rawUrl) {
  try { return new URL(rawUrl).hostname.replace(/^www\./i, ""); } catch (err) { return ""; }
}

function safeFileName(value) {
  var name = cleanText(value, 120)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!name) name = "video";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = "video " + name;
  return name.slice(0, 100).trim() || "video";
}

function extensionOf(rawUrl) {
  try {
    var pathname = new URL(rawUrl).pathname.toLowerCase();
    var match = pathname.match(/\.(mp4|m4v|webm|flv|mkv|mov)$/);
    return match ? "." + match[1] : "";
  } catch (err) { return ""; }
}

function contentTypeOf(value) {
  return cleanText(value, 160).toLowerCase().split(";")[0].trim();
}

function looksLikeMediaSegment(rawUrl) {
  try {
    var pathname = new URL(rawUrl).pathname.toLowerCase();
    if (/\.(?:ts|m4s|aac|vtt|key)$/i.test(pathname)) return true;
    if (/\/(?:segments?|chunks?|fragments?|init)\//i.test(pathname)) return true;
    var base = pathname.split("/").pop() || "";
    if (/^init\.(?:mp4|m4v)$/i.test(base)) return true;
    // HLS byte-range segments often masquerade as .mp4. Keep those out, but
    // do not misclassify a normal movie whose title contains "part" or "frag".
    return /^(?:seg|segment|chunk|frag)[-_.]?\d+\.(?:mp4|m4v)$/i.test(base);
  } catch (err) { return false; }
}

function mediaKindFromUrl(rawUrl) {
  try {
    var url = new URL(rawUrl);
    var pathname = url.pathname.toLowerCase();
    if (/\.m3u8$/i.test(pathname) || /(?:^|[?&])(?:format|type|ext)=m3u8(?:&|$)/i.test(url.search)) return "hls";
    if (/\.(mp4|m4v|webm|flv|mkv|mov)$/i.test(pathname)) {
      if (looksLikeMediaSegment(rawUrl)) return null;
      return "file";
    }
  } catch (err) { /* not an absolute URL */ }
  return null;
}

function kindFromContentType(value) {
  var type = contentTypeOf(value);
  if (type === "application/vnd.apple.mpegurl" || type === "application/x-mpegurl" ||
      type === "audio/mpegurl" || type === "audio/x-mpegurl") return "hls";
  if (type === "video/mp4" || type === "video/webm" || type === "video/x-flv" || type === "video/x-matroska") return "file";
  return null;
}

function isGenericBinaryType(value) {
  return GENERIC_BINARY_TYPES.has(contentTypeOf(value));
}

function extensionFromContentType(value) {
  var type = contentTypeOf(value);
  if (type === "video/webm") return ".webm";
  if (type === "video/x-flv") return ".flv";
  if (type === "video/x-matroska") return ".mkv";
  return ".mp4";
}

function headerValue(headers, name) {
  if (!headers) return "";
  var wanted = name.toLowerCase();
  for (var key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    var value = headers[key];
    if (Array.isArray(value)) return cleanText(value[0], 200);
    return cleanText(value, 200);
  }
  return "";
}

function normalizeCapturedHeaders(rawHeaders) {
  var result = {};
  if (!rawHeaders) return result;
  for (var key of Object.keys(rawHeaders)) {
    var lower = key.toLowerCase();
    if (!CAPTURED_HEADERS.has(lower) && lower.indexOf("x-") !== 0) continue;
    var value = rawHeaders[key];
    if (Array.isArray(value)) value = value.join(", ");
    value = cleanText(value, 1600);
    if (value && !/[\r\n]/.test(value)) result[lower] = value;
  }
  return result;
}

function canonicalHeader(name) {
  return name.replace(/(^|-)([a-z])/g, function (_match, dash, letter) {
    return dash + letter.toUpperCase();
  });
}

function titleFromPage(pageTitle, rawUrl) {
  var title = cleanText(pageTitle, 180);
  var generic = /^(index|master|playlist|manifest|video|stream|media|output|hls|file|download|\d+)$/i;
  var base = "";
  try {
    base = path.basename(decodeURIComponent(new URL(rawUrl).pathname))
      .replace(/\.(m3u8|mp4|m4v|webm|flv|mkv)$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
  } catch (err) { /* use the page title */ }
  if (title) return title;
  if (base && !generic.test(base)) return base;
  return "Video";
}

function uniqueFilePath(directory, title, extension, reserved) {
  var base = safeFileName(String(title || "video").replace(/\.(mp4|m4v|webm|flv|mkv)$/i, ""));
  var suffix = extension || ".mp4";
  var candidate = path.join(directory, base + suffix);
  var number = 2;
  while (fs.existsSync(candidate) || reserved.has(candidate)) {
    candidate = path.join(directory, base + " (" + number + ")" + suffix);
    number += 1;
  }
  return candidate;
}

function isEncryptedPlaylist(text) {
  var lines = String(text || "").split(/\r?\n/);
  for (var line of lines) {
    if (!/^#EXT-X-(?:SESSION-)?KEY:/i.test(line)) continue;
    if (!/METHOD=NONE(?:,|$)/i.test(line)) return true;
  }
  return false;
}

function isLivePlaylist(text) {
  if (/#EXT-X-ENDLIST/i.test(text) || /#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(text)) return false;
  return true;
}

function playlistDuration(text) {
  var total = 0;
  var lines = String(text || "").split(/\r?\n/);
  for (var line of lines) {
    if (!/^#EXTINF:/i.test(line)) continue;
    var value = parseFloat(line.slice(line.indexOf(":") + 1));
    if (isFinite(value) && value > 0) total += value;
  }
  return total;
}

function parseVariants(text, baseUrl) {
  var lines = String(text || "").split(/\r?\n/);
  var variants = [];
  for (var i = 0; i < lines.length; i += 1) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
    var attrs = lines[i].slice(lines[i].indexOf(":") + 1);
    var bandwidthMatch = attrs.match(/(?:^|,)BANDWIDTH=(\d+)/i);
    var resolutionMatch = attrs.match(/(?:^|,)RESOLUTION=(\d+)x(\d+)/i);
    var uri = "";
    for (var j = i + 1; j < lines.length; j += 1) {
      var candidate = lines[j].trim();
      if (!candidate) continue;
      if (candidate.charAt(0) !== "#") { uri = candidate; break; }
    }
    if (!uri) continue;
    var absolute;
    try { absolute = new URL(uri, baseUrl).href; } catch (err) { continue; }
    variants.push({
      url: absolute,
      bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0,
      width: resolutionMatch ? parseInt(resolutionMatch[1], 10) : 0,
      height: resolutionMatch ? parseInt(resolutionMatch[2], 10) : 0
    });
  }
  variants.sort(function (a, b) {
    return b.bandwidth - a.bandwidth || b.height - a.height;
  });
  var labelCounts = {};
  return variants.map(function (variant, index) {
    var parts = [];
    if (variant.height) parts.push(variant.height + "p");
    if (variant.bandwidth) parts.push((variant.bandwidth / 1000000).toFixed(1) + " Mbps");
    if (!parts.length) parts.push("Quality " + (index + 1));
    var label = parts.join(" · ");
    labelCounts[label] = (labelCounts[label] || 0) + 1;
    if (labelCounts[label] > 1) label += " (" + labelCounts[label] + ")";
    return {
      id: "q" + index,
      label: label,
      url: variant.url,
      bandwidth: variant.bandwidth,
      width: variant.width,
      height: variant.height
    };
  });
}

function selectBestVariant(text, baseUrl) {
  var variants = parseVariants(text, baseUrl);
  if (!variants.length) return null;
  return { url: variants[0].url, bandwidth: variants[0].bandwidth };
}

function userError(message, code) {
  var error = new Error(message);
  error.userMessage = message;
  if (code) error.code = code;
  return error;
}

function ffmpegPath() {
  if (process.env.ANYSREAM_FFMPEG) return process.env.ANYSREAM_FFMPEG;
  if (app.isPackaged) {
    var packaged = path.join(process.resourcesPath, "bin", "ffmpeg.exe");
    if (fs.existsSync(packaged)) return packaged;
  }
  try { return require("ffmpeg-static"); } catch (err) { return "ffmpeg"; }
}

class DownloadManager {
  constructor(options) {
    this.getSiteView = options.getSiteView;
    this.getSession = options.getSession;
    this.send = options.send;
    this.downloadsDir = options.downloadsDir || app.getPath("downloads");
    this.media = [];
    this.jobs = [];
    this.tasks = new Map();
    this.reservedPaths = new Set();
    this.requestHeaders = new Map();
    this.internalRequests = new Set();
    this.debuggerContents = null;
    this.debuggerMessageHandler = null;
    this.debuggerDetachHandler = null;
    this.sniffResponses = new Map();
    this.sniffBudget = 80;
    this.attached = false;
    this.ffmpeg = ffmpegPath();
    this.attachToSession();
  }

  attachToSession() {
    if (this.attached) return;
    var ses = this.getSession();
    if (!ses) return;
    this.attached = true;
    var filter = { urls: ["*://*/*"] };
    ses.webRequest.onBeforeRequest(filter, (details, callback) => {
      try { this.observeRequest(details); } catch (err) { /* never break the site */ }
      callback({});
    });
    ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      try { this.captureRequestHeaders(details); } catch (err) { /* ignore */ }
      callback({ requestHeaders: details.requestHeaders });
    });
    ses.webRequest.onHeadersReceived(filter, (details, callback) => {
      try { this.observeResponse(details); } catch (err) { /* ignore */ }
      callback({ responseHeaders: details.responseHeaders });
    });
  }

  watchSiteView(view) {
    var wc = view && view.webContents;
    if (!wc || wc.isDestroyed() || this.debuggerContents === wc) return;
    this.releaseSiteView();
    try { wc.debugger.attach("1.3"); } catch (err) { return; }
    this.debuggerContents = wc;
    this.sniffBudget = 80;
    this.debuggerMessageHandler = (event, method, params) => {
      try { this.handleDebuggerMessage(wc, method, params); } catch (err) { /* ignore */ }
    };
    this.debuggerDetachHandler = () => {
      if (this.debuggerContents !== wc) return;
      this.debuggerContents = null;
      this.sniffResponses.clear();
      this.debuggerMessageHandler = null;
      this.debuggerDetachHandler = null;
    };
    wc.debugger.on("message", this.debuggerMessageHandler);
    wc.debugger.on("detach", this.debuggerDetachHandler);
    try {
      var enabled = wc.debugger.sendCommand("Network.enable", {
        maxTotalBufferSize: 64 * 1024 * 1024,
        maxResourceBufferSize: 8 * 1024 * 1024
      });
      if (enabled && enabled.catch) enabled.catch(function () {});
    } catch (err) { /* header detection still works */ }
  }

  releaseSiteView() {
    var wc = this.debuggerContents;
    this.debuggerContents = null;
    this.sniffResponses.clear();
    if (!wc) return;
    var message = this.debuggerMessageHandler;
    var detach = this.debuggerDetachHandler;
    this.debuggerMessageHandler = null;
    this.debuggerDetachHandler = null;
    try {
      if (message) wc.debugger.removeListener("message", message);
      if (detach) wc.debugger.removeListener("detach", detach);
    } catch (err) { /* already detached */ }
    try {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
    } catch (err) { /* already detached */ }
  }

  isSniffCandidate(response, type) {
    if (!response || response.status !== 200) return false;
    if (type !== "XHR" && type !== "Fetch" && type !== "Other") return false;
    var url = String(response.url || "");
    if (!/^https?:\/\//i.test(url) || this.internalRequests.has(url)) return false;
    if (mediaKindFromUrl(url) === "hls" || looksLikeMediaSegment(url)) return false;
    var mime = contentTypeOf(response.mimeType);
    if (mime === "application/vnd.apple.mpegurl" || mime === "application/x-mpegurl" ||
        mime === "audio/mpegurl" || mime === "audio/x-mpegurl") return false;
    if (!SNIFFABLE_MIME_TYPES.has(mime)) return false;
    var size = parseInt(headerValue(response.headers, "content-length"), 10);
    if (isFinite(size) && size > MAX_SNIFF_BYTES) return false;
    return true;
  }

  handleDebuggerMessage(wc, method, params) {
    if (!this.debuggerContents || this.debuggerContents !== wc || !params) return;
    if (method === "Network.responseReceived") {
      var response = params.response;
      if (!this.isSniffCandidate(response, params.type)) return;
      this.sniffResponses.set(params.requestId, {
        url: response.url,
        headers: response.headers || {}
      });
      while (this.sniffResponses.size > MAX_SNIFF_RESPONSES) {
        this.sniffResponses.delete(this.sniffResponses.keys().next().value);
      }
      return;
    }
    if (method === "Network.loadingFailed") {
      this.sniffResponses.delete(params.requestId);
      return;
    }
    if (method !== "Network.loadingFinished") return;
    var info = this.sniffResponses.get(params.requestId);
    if (!info) return;
    this.sniffResponses.delete(params.requestId);
    if (this.sniffBudget <= 0) return;
    if (params.encodedDataLength > MAX_SNIFF_BYTES) return;
    this.sniffBudget -= 1;
    var self = this;
    try {
      wc.debugger.sendCommand("Network.getResponseBody", { requestId: params.requestId }).then(function (result) {
        if (!result || typeof result.body !== "string" || self.debuggerContents !== wc) return;
        var body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
        if (!/^#EXTM3U(?:\r?\n|$)/.test(body.replace(/^\uFEFF/, "").trimStart())) return;
        self.addMedia(info.url, "hls", wc.getURL(), "application/vnd.apple.mpegurl", self.requestHeaders.get(info.url));
      }).catch(function () {});
    } catch (err) { /* response body is optional */ }
  }

  siteWebContents() {
    var view = this.getSiteView && this.getSiteView();
    if (!view || !view.webContents) return null;
    if (view.webContents.isDestroyed()) return null;
    return view.webContents;
  }

  captureRequestHeaders(details) {
    var headers = normalizeCapturedHeaders(details.requestHeaders);
    if (!Object.keys(headers).length) return;
    this.requestHeaders.set(details.url, headers);
    if (this.requestHeaders.size > 120) {
      var oldest = this.requestHeaders.keys().next().value;
      if (oldest) this.requestHeaders.delete(oldest);
    }
    var media = this.media.find((item) => item.url === details.url);
    if (media) media.headers = Object.assign({}, media.headers, headers);
  }

  observeRequest(details) {
    if (this.internalRequests.has(details.url)) return;
    if (details.method && details.method !== "GET") return;
    var kind = mediaKindFromUrl(details.url);
    if (!kind) return;
    if (kind === "file" && details.resourceType && details.resourceType !== "media" &&
        details.resourceType !== "xhr" && details.resourceType !== "other") return;
    this.addMedia(details.url, kind, details.referrer, "", this.requestHeaders.get(details.url));
  }

  observeResponse(details) {
    if (this.internalRequests.has(details.url)) return;
    if (details.statusCode !== 200 && details.statusCode !== 206) return;
    var contentType = headerValue(details.responseHeaders, "content-type");
    var kind = kindFromContentType(contentType);
    var genericMedia = false;
    if (!kind && details.resourceType === "media" && isGenericBinaryType(contentType)) {
      kind = "file";
      genericMedia = true;
    }
    if (!kind) return;
    if (kind === "file") {
      if (looksLikeMediaSegment(details.url)) return;
      if (details.statusCode === 206) {
        var range = headerValue(details.responseHeaders, "content-range");
        if (!/^bytes\s+0-/i.test(range)) return;
      }
      if (!genericMedia && mediaKindFromUrl(details.url) === null && !/^video\//i.test(contentType)) return;
    }
    this.addMedia(details.url, kind, details.referrer, contentType, this.requestHeaders.get(details.url));
  }

  addMedia(url, kind, referrer, contentType, headers) {
    var wc = this.siteWebContents();
    if (!wc) return;
    var pageUrl = /^https?:\/\//i.test(referrer || "") ? referrer : wc.getURL();
    var ext = kind === "hls" ? ".mp4" : (extensionOf(url) || extensionFromContentType(contentType));
    var existing = this.media.find((item) => item.url === url);
    var captured = normalizeCapturedHeaders(headers);
    if (existing) {
      existing.headers = Object.assign({}, existing.headers, captured);
      if (!existing.pageTitle) existing.pageTitle = cleanText(wc.getTitle(), 180);
      return;
    }
    var id = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
    var pageTitle = cleanText(wc.getTitle(), 180);
    var item = {
      id: id,
      url: url,
      kind: kind,
      ext: ext,
      title: titleFromPage(pageTitle, url),
      pageTitle: pageTitle,
      pageUrl: pageUrl,
      host: hostOf(url),
      contentType: contentType || "",
      headers: captured,
      qualities: [],
      qualityState: kind === "hls" ? "loading" : "ready",
      qualityError: "",
      discoveredAt: Date.now()
    };
    this.media.unshift(item);
    if (this.media.length > MAX_MEDIA) this.media.length = MAX_MEDIA;
    this.emit();
    if (kind === "hls") setTimeout(() => this.loadQualities(item), 200);
  }

  async loadQualities(media) {
    if (!media || media.kind !== "hls") return;
    try {
      var master = await this.fetchPlaylist(media.url, media);
      if (!/^#EXTM3U/m.test(master)) throw userError("That address did not return an HLS video playlist.");
      if (isEncryptedPlaylist(master)) throw userError("This stream is encrypted or DRM-protected, so it cannot be downloaded.");
      var variants = parseVariants(master, media.url);
      media.qualities = variants.length
        ? variants.map(function (variant) {
            return { id: variant.id, label: variant.label, url: variant.url, bandwidth: variant.bandwidth, width: variant.width, height: variant.height };
          })
        : [{ id: "source", label: "Source quality", url: media.url, bandwidth: 0, width: 0, height: 0 }];
      media.qualityState = "ready";
      media.qualityError = "";
    } catch (err) {
      media.qualities = [];
      media.qualityState = "error";
      media.qualityError = (err && err.userMessage) || "The available qualities could not be read.";
    }
    this.emit();
  }

  resetMedia() {
    this.media = [];
    this.requestHeaders.clear();
    this.emit();
  }

  publicState() {
    return {
      engine: Boolean(this.ffmpeg),
      media: this.media.map((item) => ({
        id: item.id,
        title: item.title,
        host: item.host,
        kind: item.kind,
        ext: item.ext,
        qualities: item.qualities.map(function (quality) { return { id: quality.id, label: quality.label }; }),
        qualityState: item.qualityState,
        qualityError: item.qualityError,
        discoveredAt: item.discoveredAt
      })),
      jobs: this.jobs.map((job) => ({
        id: job.id,
        mediaId: job.mediaId,
        title: job.title,
        state: job.state,
        percent: job.percent,
        received: job.received,
        total: job.total,
        elapsed: job.elapsed,
        duration: job.duration,
        qualityLabel: job.qualityLabel,
        fileName: job.fileName,
        error: job.error,
        completedAt: job.completedAt
      }))
    };
  }

  emit() {
    if (typeof this.send === "function") this.send(this.publicState());
  }

  start(mediaId, qualityId) {
    var media = this.media.find((item) => item.id === mediaId);
    if (!media) return { ok: false, error: "That stream is no longer available. Reload the video and try again." };
    var selectedQuality = null;
    if (media.kind === "hls" && typeof qualityId === "string") {
      selectedQuality = media.qualities.find(function (quality) { return quality.id === qualityId; }) || null;
    }
    var running = this.jobs.find((job) => job.mediaId === mediaId && ACTIVE_STATES.has(job.state));
    if (running) return { ok: false, error: "That video is already downloading." };
    if (media.kind === "hls" && !this.ffmpeg) {
      return { ok: false, error: "The video engine is missing from this build." };
    }
    fs.mkdirSync(this.downloadsDir, { recursive: true });
    var extension = media.kind === "hls" ? ".mp4" : (media.ext || ".mp4");
    var filePath = uniqueFilePath(this.downloadsDir, media.title, extension, this.reservedPaths);
    this.reservedPaths.add(filePath);
    var job = {
      id: crypto.randomUUID(),
      mediaId: media.id,
      title: media.title,
      kind: media.kind,
      state: media.kind === "hls" ? "checking" : "downloading",
      percent: media.kind === "hls" ? 0 : null,
      received: 0,
      total: 0,
      elapsed: 0,
      duration: 0,
      qualityLabel: selectedQuality ? selectedQuality.label : (media.kind === "hls" ? "Best available" : ""),
      fileName: path.basename(filePath),
      filePath: filePath,
      error: "",
      completedAt: 0
    };
    this.jobs.unshift(job);
    this.trimJobs();
    this.emit();
    if (media.kind === "hls") {
      this.runHls(media, job, selectedQuality).catch((err) => this.failJob(job, err));
    } else {
      Promise.resolve().then(() => this.runDirect(media, job)).catch((err) => this.failJob(job, err));
    }
    return { ok: true, id: job.id };
  }

  trimJobs() {
    while (this.jobs.length > MAX_JOBS) {
      var index = -1;
      for (var i = this.jobs.length - 1; i >= 0; i -= 1) {
        if (!ACTIVE_STATES.has(this.jobs[i].state)) { index = i; break; }
      }
      if (index === -1) break;
      this.jobs.splice(index, 1);
    }
  }

  removeReservation(job) {
    if (job && job.filePath) this.reservedPaths.delete(job.filePath);
  }

  failJob(job, error) {
    if (!job || job.state === "cancelled" || job.state === "complete" || job.state === "error") return;
    var task = this.tasks.get(job.id);
    if (task && task.tempPath) {
      try { fs.unlinkSync(task.tempPath); } catch (err) { /* not written yet */ }
    }
    this.tasks.delete(job.id);
    this.removeReservation(job);
    job.state = "error";
    job.error = (error && error.userMessage) || "The video could not be downloaded. The stream may have expired or require a sign-in.";
    job.percent = null;
    this.emit();
  }

  completeJob(job, tempPath) {
    if (!job || job.state === "cancelled") {
      try { fs.unlinkSync(tempPath); } catch (err) { /* already gone */ }
      return;
    }
    try {
      var info = fs.statSync(tempPath);
      if (!info.size) throw new Error("empty");
      fs.renameSync(tempPath, job.filePath);
      job.state = "complete";
      job.percent = 1;
      job.received = info.size;
      job.total = info.size;
      job.completedAt = Date.now();
      job.error = "";
      this.tasks.delete(job.id);
      this.emit();
    } catch (err) {
      this.failJob(job, userError("The downloaded file could not be saved."));
    }
  }

  cancel(jobId) {
    var job = this.jobs.find((item) => item.id === jobId);
    if (!job || !ACTIVE_STATES.has(job.state)) return false;
    var task = this.tasks.get(job.id);
    job.state = "cancelled";
    job.error = "Cancelled";
    job.percent = null;
    if (task) {
      task.cancelled = true;
      if (task.type === "ffmpeg" && task.child) {
        try { task.child.kill(); } catch (err) { /* already closed */ }
      }
      if (task.type === "direct") {
        try { if (task.request) task.request.abort(); } catch (err) { /* already closed */ }
        try { if (task.file) task.file.destroy(); } catch (err) { /* already closed */ }
        try { if (task.tempPath) fs.unlinkSync(task.tempPath); } catch (err) { /* already gone */ }
      }
      this.tasks.delete(job.id);
    }
    this.removeReservation(job);
    this.emit();
    return true;
  }

  async sessionRequestHeaders(media) {
    var headers = {
      Accept: "application/vnd.apple.mpegurl, application/x-mpegurl, */*"
    };
    if (media.headers && media.headers.authorization) headers.Authorization = media.headers.authorization;
    if (media.headers && media.headers.origin) headers.Origin = media.headers.origin;
    headers.Referer = (media.headers && media.headers.referer) || media.pageUrl || media.url;
    if (media.headers && media.headers["user-agent"]) headers["User-Agent"] = media.headers["user-agent"];
    return headers;
  }

  fetchPlaylist(rawUrl, media) {
    var self = this;
    self.internalRequests.add(rawUrl);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        self.internalRequests.delete(rawUrl);
        if (error) reject(error); else resolve(value);
      }
      var request;
      try {
        request = net.request({
          method: "GET",
          url: rawUrl,
          session: self.getSession(),
          useSessionCookies: true,
          redirect: "follow",
          headers: self.sessionRequestHeaders(media)
        });
      } catch (err) {
        finish(userError("The stream address could not be opened."));
        return;
      }
      timer = setTimeout(function () {
        try { request.abort(); } catch (err) { /* already done */ }
        finish(userError("The stream took too long to respond."));
      }, 30000);
      request.on("response", function (response) {
        var status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          if (status === 401 || status === 403) finish(userError("The site refused the download (HTTP " + status + "). Reload the video and try again."));
          else finish(userError("The stream returned HTTP " + status + ". Reload the video and try again."));
          return;
        }
        var chunks = [];
        var size = 0;
        response.on("data", function (chunk) {
          size += chunk.length;
          if (size > MAX_PLAYLIST_BYTES) {
            try { request.abort(); } catch (err) { /* already done */ }
            finish(userError("That stream returned an unexpectedly large playlist."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", function () { finish(null, Buffer.concat(chunks).toString("utf8")); });
        response.on("aborted", function () { finish(userError("The stream connection was interrupted.")); });
        response.on("error", function () { finish(userError("The stream could not be read.")); });
      });
      request.on("error", function () { finish(userError("The site could not be reached for this stream.")); });
      request.end();
    });
  }

  async resolveHls(media, selectedQuality) {
    var master = await this.fetchPlaylist(media.url, media);
    if (!/^#EXTM3U/m.test(master)) throw userError("That address did not return an HLS video playlist.");
    if (isEncryptedPlaylist(master)) throw userError("This stream is encrypted or DRM-protected, so it cannot be downloaded.");
    var variants = parseVariants(master, media.url);
    var variant = null;
    if (variants.length) {
      if (selectedQuality) {
        variant = variants.find(function (candidate) { return candidate.id === selectedQuality.id; }) || null;
      }
      if (!variant) variant = variants[0];
    }
    var selectedUrl = media.url;
    var playlist = master;
    if (variant) {
      selectedUrl = variant.url;
      playlist = await this.fetchPlaylist(selectedUrl, media);
      if (!/^#EXTM3U/m.test(playlist)) throw userError("The selected HLS quality did not return a video playlist.");
      if (isEncryptedPlaylist(playlist)) throw userError("This stream is encrypted or DRM-protected, so it cannot be downloaded.");
    }
    if (isLivePlaylist(playlist)) throw userError("This appears to be a live stream. Live recording is not supported.");
    return { url: selectedUrl, duration: playlistDuration(playlist) };
  }

  async ffmpegHeaders(media) {
    var block = {};
    var captured = media.headers || {};
    for (var key of Object.keys(captured)) {
      if (key === "user-agent" || key === "cookie") continue;
      block[canonicalHeader(key)] = cleanText(captured[key], 1600);
    }
    if (!block.Referer) block.Referer = media.pageUrl || media.url;
    var userAgent = captured["user-agent"] || "";
    var cookieParts = [];
    var seen = new Set();
    var ses = this.getSession();
    var targets = Array.from(new Set([media.url, media.pageUrl].filter(Boolean)));
    for (var target of targets) {
      try {
        var cookies = await ses.cookies.get({ url: target });
        for (var cookie of cookies) {
          if (!cookie || !cookie.name || seen.has(cookie.name)) continue;
          seen.add(cookie.name);
          cookieParts.push(cookie.name + "=" + cookie.value);
        }
      } catch (err) { /* cookies are optional */ }
    }
    if (cookieParts.length) block.Cookie = cookieParts.join("; ");
    var headers = Object.keys(block).map(function (name) {
      return name + ": " + block[name].replace(/[\r\n]/g, " ");
    }).join("\r\n");
    return { headers: headers ? headers + "\r\n" : "", userAgent: userAgent };
  }

  async runHls(media, job, selectedQuality) {
    if (!this.ffmpeg) throw userError("The video engine is missing from this build.");
    job.state = "checking";
    this.emit();
    var resolved = await this.resolveHls(media, selectedQuality);
    if (job.state === "cancelled") return;
    job.duration = resolved.duration;
    job.percent = resolved.duration > 0 ? 0 : null;
    job.state = "downloading";
    this.emit();
    var tempPath = job.filePath + ".part.mp4";
    var details = await this.ffmpegHeaders(media);
    var siteView = this.getSiteView && this.getSiteView();
    var siteWebContents = siteView && siteView.webContents && !siteView.webContents.isDestroyed() ? siteView.webContents : null;
    var userAgent = details.userAgent || (siteWebContents ? siteWebContents.getUserAgent() : "");
    var args = [
      "-hide_banner", "-nostdin", "-y", "-loglevel", "warning",
      "-rw_timeout", "30000000", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"
    ];
    if (userAgent) args.push("-user_agent", userAgent);
    if (details.headers) args.push("-headers", details.headers);
    args.push(
      "-i", resolved.url,
      "-map", "0:v:0?", "-map", "0:a:0?",
      "-c", "copy", "-movflags", "+faststart",
      "-max_muxing_queue_size", "4096",
      "-progress", "pipe:1", "-nostats",
      tempPath
    );
    var task = { type: "ffmpeg", child: null, tempPath: tempPath, cancelled: false };
    this.tasks.set(job.id, task);
    var child;
    try {
      child = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this.failJob(job, userError("The bundled video engine could not be started."));
      return;
    }
    task.child = child;
    var stderr = "";
    var progressBuffer = "";
    var lastEmit = 0;
    var settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", function (chunk) {
      stderr = (stderr + chunk).slice(-12000);
    });
    child.stdout.on("data", function (chunk) {
      progressBuffer += chunk;
      var lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop();
      for (var line of lines) {
        var split = line.indexOf("=");
        if (split === -1) continue;
        var key = line.slice(0, split);
        var value = line.slice(split + 1).trim();
        if (key === "total_size") {
          var bytes = parseInt(value, 10);
          if (isFinite(bytes) && bytes >= 0) job.received = bytes;
        } else if (key === "out_time_us" || key === "out_time_ms") {
          var seconds = parseInt(value, 10) / 1000000;
          if (isFinite(seconds) && seconds >= 0) {
            job.elapsed = Math.max(0, seconds);
            if (job.duration > 0) job.percent = Math.max(0, Math.min(0.99, seconds / job.duration));
          }
        }
      }
      var now = Date.now();
      if (now - lastEmit > 350) {
        lastEmit = now;
        this.emit();
      }
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      this.failJob(job, userError("The bundled video engine could not be started."));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (task.cancelled || job.state === "cancelled") {
        this.tasks.delete(job.id);
        try { fs.unlinkSync(tempPath); } catch (err) { /* already gone */ }
        return;
      }
      if (code !== 0) {
        var message = "The stream could not be downloaded. It may have expired, require a sign-in, or use DRM.";
        if (/HTTP error 4(?:01|03)|Server returned 4(?:01|03)/i.test(stderr)) message = "The site refused the download. Reload the video and try again.";
        this.failJob(job, userError(message));
        return;
      }
      this.completeJob(job, tempPath);
    });
  }

  directHeaders(media) {
    var headers = {};
    var captured = media.headers || {};
    if (captured.authorization) headers.Authorization = captured.authorization;
    if (captured["user-agent"]) headers["User-Agent"] = captured["user-agent"];
    headers.Referer = captured.referer || media.pageUrl || media.url;
    if (captured.origin) headers.Origin = captured.origin;
    return headers;
  }

  async runDirect(media, job) {
    var tempPath = job.filePath + ".part";
    var task = { type: "direct", request: null, file: null, tempPath: tempPath, cancelled: false };
    this.tasks.set(job.id, task);
    var request;
    try {
      request = net.request({
        method: "GET",
        url: media.url,
        session: this.getSession(),
        useSessionCookies: true,
        redirect: "follow",
        headers: this.directHeaders(media)
      });
    } catch (err) {
      this.failJob(job, userError("The video address could not be opened."));
      return;
    }
    task.request = request;
    var settled = false;
    var file = null;
    var finish = (error) => {
      if (settled) return;
      settled = true;
      this.tasks.delete(job.id);
      if (!error) return;
      try { if (file) file.destroy(); } catch (err) { /* already closed */ }
      try { fs.unlinkSync(tempPath); } catch (err) { /* already gone */ }
      this.failJob(job, error);
    };
    request.on("response", (response) => {
      var status = response.statusCode || 0;
      if (status !== 200 && status !== 206) {
        finish(status === 401 || status === 403
          ? userError("The site refused the download (HTTP " + status + "). Reload the video and try again.")
          : userError("The video returned HTTP " + status + "."));
        return;
      }
      if (status === 206) {
        var range = headerValue(response.headers, "content-range");
        if (!/^bytes\s+0-/i.test(range)) {
          finish(userError("That file is only a video fragment, not a complete movie."));
          return;
        }
      }
      var contentType = headerValue(response.headers, "content-type");
      if (kindFromContentType(contentType) === "hls") {
        finish(userError("This is a streaming playlist, not a complete video file."));
        return;
      }
      var length = parseInt(headerValue(response.headers, "content-length"), 10);
      job.total = isFinite(length) && length > 0 ? length : 0;
      try { file = fs.createWriteStream(tempPath, { flags: "w" }); } catch (err) {
        finish(userError("The downloaded file could not be created."));
        return;
      }
      task.file = file;
      file.on("error", () => finish(userError("The downloaded file could not be written.")));
      file.on("finish", () => {
        if (settled) return;
        if (task.cancelled) return;
        settled = true;
        this.tasks.delete(job.id);
        this.completeJob(job, tempPath);
      });
      response.on("data", (chunk) => {
        if (settled || task.cancelled) return;
        job.received += chunk.length;
        if (job.total > 0) job.percent = Math.max(0, Math.min(0.99, job.received / job.total));
        var now = Date.now();
        if (now - (job._lastEmit || 0) > 350) {
          job._lastEmit = now;
          this.emit();
        }
        if (!file.write(chunk)) {
          response.pause();
          file.once("drain", () => response.resume());
        }
      });
      response.on("end", () => { if (!settled && !task.cancelled) file.end(); });
      response.on("aborted", () => finish(userError("The video connection was interrupted.")));
      response.on("error", () => finish(userError("The video could not be read.")));
    });
    request.on("error", () => finish(userError("The site could not be reached for this video.")));
    request.end();
  }

  show(jobId) {
    var job = this.jobs.find((item) => item.id === jobId);
    if (job && job.state === "complete" && fs.existsSync(job.filePath)) {
      shell.showItemInFolder(job.filePath);
      return true;
    }
    shell.openPath(this.downloadsDir);
    return false;
  }

  openFolder() {
    return shell.openPath(this.downloadsDir);
  }

  clearFinished() {
    this.jobs = this.jobs.filter((job) => ACTIVE_STATES.has(job.state));
    this.emit();
  }

  stopAll() {
    for (var job of this.jobs) {
      if (ACTIVE_STATES.has(job.state)) {
        job.state = "cancelled";
        var task = this.tasks.get(job.id);
        if (!task) continue;
        if (task.type === "ffmpeg" && task.child) {
          try { task.child.kill(); } catch (err) { /* already closed */ }
        }
        if (task.type === "direct") {
          try { if (task.request) task.request.abort(); } catch (err) { /* already closed */ }
          try { if (task.file) task.file.destroy(); } catch (err) { /* already closed */ }
          try { if (task.tempPath) fs.unlinkSync(task.tempPath); } catch (err) { /* already gone */ }
        }
      }
    }
  }
}

module.exports = { DownloadManager, _internals: { mediaKindFromUrl, looksLikeMediaSegment, isEncryptedPlaylist, playlistDuration, parseVariants, selectBestVariant, safeFileName } };