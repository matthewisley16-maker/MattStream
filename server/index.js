'use strict';

// MattStream server: scans your folders, serves the web app, and streams any format.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const { Store } = require('./store');
const { resolveFfmpeg, ffmpegWorks, buildPlayArgs } = require('./media');
const { scanLibrary, sortTitle, VIDEO_EXT, prettySize } = require('./scan');
const tmdb = require('./tmdb');

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.MATTSTREAM_DATA
  ? path.resolve(process.env.MATTSTREAM_DATA)
  : path.join(APP_ROOT, 'data');
const WEB_DIR = path.join(APP_ROOT, 'web');
const VERSION = require(path.join(APP_ROOT, 'package.json')).version;

const configStore = new Store(path.join(DATA_DIR, 'config.json'), () => ({
  libraries: [],
  hidden: [],
  port: 8096,
}));
const libraryStore = new Store(path.join(DATA_DIR, 'library.json'), () => ({
  items: [],
  scannedAt: 0,
}));
const probeStore = new Store(path.join(DATA_DIR, 'probes.json'), () => ({}));
const progressStore = new Store(path.join(DATA_DIR, 'progress.json'), () => ({}));
const metadataStore = new Store(path.join(DATA_DIR, 'metadata.json'), () => ({}));
const ART_DIR = path.join(DATA_DIR, 'art');
const DEFAULTS_FILE = path.join(APP_ROOT, 'config', 'defaults.json');

// The server this installation offers as its default library. It is a plain
// config file the owner can edit or delete; other people point their app at
// their own server instead.
function readDefaults() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
    const server = parsed && parsed.defaultServer;
    if (!server || !server.url) return { defaultServer: null };
    return {
      defaultServer: {
        name: String(server.name || 'My Library'),
        url: String(server.url),
      },
    };
  } catch (err) {
    return { defaultServer: null };
  }
}

const FFMPEG = resolveFfmpeg(APP_ROOT);

// Screens keeping a cast channel open, keyed by their client id.
const castClients = new Map();
// What each casting screen is playing, so the casting device can drive it.
const castSessions = new Map();

const state = {
  scanning: false,
  scanDone: 0,
  scanTotal: 0,
  ffmpegOk: false,
  startedAt: Date.now(),
  log: [],
};

let byId = new Map();

// ---------- admin ----------
// The desktop app runs on this machine, so loopback is trusted. Other devices
// unlock changes (adding, editing, deleting) with the key shown in the app.
function adminKey() {
  const data = configStore.read();
  if (data.adminKey) return data.adminKey;
  const key = crypto.randomBytes(9).toString('hex');
  configStore.update((d) => {
    d.adminKey = key;
  });
  configStore.flush();
  return key;
}

// Only a real request from this machine counts as the owner sitting in front of
// it. A tunnel or reverse proxy also reaches us from 127.0.0.1, so a request that
// carries forwarding headers - or that arrives for a host name that is not this
// machine - is remote and has to present the admin key like any other device.
function isLoopback(req) {
  const address = (req.socket && req.socket.remoteAddress) || '';
  const fromThisMachine = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  if (!fromThisMachine) return false;

  const headers = req.headers || {};
  if (
    headers['cf-connecting-ip'] ||
    headers['cf-ray'] ||
    headers['x-forwarded-for'] ||
    headers['x-real-ip'] ||
    headers['forwarded']
  ) {
    return false;
  }

  const host = String(headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return host === '' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function isAdmin(req) {
  if (isLoopback(req)) return true;
  const given = String(req.headers['x-mattstream-key'] || '');
  return given.length > 0 && given === adminKey();
}

function requireAdmin(res, req) {
  if (isAdmin(req)) return true;
  sendJson(res, 403, { error: 'Admin key required to change this server.', adminRequired: true });
  return false;
}

// Hand-entered details and artwork win over whatever the files say.
function applyOverride(item, override) {
  if (!override) return item;
  if (override.title) {
    item.title = override.title;
    item.sortTitle = sortTitle(override.title);
  }
  if (override.year) item.year = override.year;
  if (typeof override.overview === 'string' && override.overview) item.overview = override.overview;
  if (Array.isArray(override.genres) && override.genres.length) item.genres = override.genres;
  if (override.runtime) item.runtime = override.runtime;
  if (override.posterPath) item.posterPath = override.posterPath;
  if (override.backdropPath) item.backdropPath = override.backdropPath;
  if (override.thumbPath) item.thumbPath = override.thumbPath;
  if (override.series) {
    item.series = override.series;
    item.seriesSort = sortTitle(override.series);
  }
  return item;
}

function log(message) {
  const line = new Date().toLocaleTimeString() + '  ' + message;
  console.log('[mattstream] ' + message);
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
}

function reindex() {
  byId = new Map();
  for (const item of libraryStore.read().items || []) byId.set(item.id, item);
}

// The quick tunnel's address is printed by cloudflared; the server reads it
// straight from the log so the app can always show a reachable address.
// Whether Windows actually lets other devices in. Asked of Windows rather than
// assumed, so the app can never claim a block that is not there (or miss one).
let firewallChecked = { at: 0, allowed: null };

function firewallAllows() {
  if (process.platform !== 'win32') return null;
  if (Date.now() - firewallChecked.at < 30000) return firewallChecked.allowed;
  let allowed = null;
  try {
    const out = execFileSync(
      'netsh',
      ['advfirewall', 'firewall', 'show', 'rule', 'name=MattStream-8096'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }
    );
    if (/Action:\s*Allow/i.test(out)) allowed = /Enabled:\s*Yes/i.test(out);
    else if (/Action:\s*Block/i.test(out)) allowed = false;
  } catch (err) {
    allowed = null;
  }
  firewallChecked = { at: Date.now(), allowed };
  return allowed;
}

function tunnelUrl() {
  try {
    const saved = path.join(APP_ROOT, '.tools', 'public-url.txt');
    if (fs.existsSync(saved)) {
      const value = fs.readFileSync(saved, 'utf8').trim();
      if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(value)) return value;
    }
  } catch (err) {
    /* fall through to the log */
  }
  try {
    const logPath = path.join(APP_ROOT, '.tools', 'tunnel.log');
    if (!fs.existsSync(logPath)) return '';
    const content = fs.readFileSync(logPath, 'utf8');
    const matches = content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    return matches && matches.length ? matches[matches.length - 1] : '';
  } catch (err) {
    return '';
  }
}

function lanUrls(port) {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push('http://' + net.address + ':' + port);
    }
  }
  return urls;
}

// ---------- scanning ----------

let rescanQueued = false;

// A file with no poster or artwork anywhere still deserves a real image, so
// grab an actual frame from the video itself. Generated once per item, then
// cached in data/art and reused until the file changes.
function extractFrame(item, kind) {
  return new Promise((resolve) => {
    const out = path.join(ART_DIR, 'auto-' + item.id + '-' + kind + '.jpg');
    if (fs.existsSync(out)) return resolve(out);
    if (!state.ffmpegOk) return resolve(null);
    try {
      fs.mkdirSync(ART_DIR, { recursive: true });
    } catch (err) {
      return resolve(null);
    }

    const at = Math.max(5, Math.min(120, Math.round((item.duration || 300) * 0.25)));
    const scale = kind === 'poster' ? 'scale=-2:750,crop=500:750' : 'scale=1280:-2';
    const child = spawn(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', item.path, '-frames:v', '1', '-vf', scale, '-q:v', '3', out],
      { windowsHide: true }
    );
    child.on('error', () => resolve(null));
    child.on('exit', () => resolve(fs.existsSync(out) ? out : null));
  });
}

// Cover art stored inside the file itself (MKV/MP4 attachments). This is the
// film's own artwork, so it is preferred over anything cut from the video.
function extractEmbeddedCover(item) {
  return new Promise((resolve) => {
    if (item.coverStream === null || item.coverStream === undefined) return resolve(null);
    const ext = /png/i.test(item.coverCodec || '') ? '.png' : '.jpg';
    const out = path.join(ART_DIR, 'cover-' + item.id + ext);
    try {
      if (fs.existsSync(out) && fs.statSync(out).size > 1000) return resolve(out);
    } catch (err) {
      /* fall through and rebuild it */
    }
    if (!state.ffmpegOk) return resolve(null);
    try {
      fs.mkdirSync(ART_DIR, { recursive: true });
    } catch (err) {
      return resolve(null);
    }
    const child = spawn(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', item.path, '-map', '0:' + item.coverStream, '-c', 'copy', '-frames:v', '1', out],
      { windowsHide: true }
    );
    child.on('error', () => resolve(null));
    child.on('exit', () => {
      try {
        resolve(fs.existsSync(out) && fs.statSync(out).size > 1000 ? out : null);
      } catch (err) {
        resolve(null);
      }
    });
  });
}

// A real cover linked by an .nfo (Kodi-style <thumb>/<fanart> URL), saved once.
async function fetchRemoteArt(url, item, kind) {
  if (!url) return null;
  const ext = /\.png(\?|$)/i.test(url) ? '.png' : '.jpg';
  const out = path.join(ART_DIR, kind + '-' + item.id + ext);
  try {
    if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
  } catch (err) {
    /* fall through */
  }
  try {
    await fsp.mkdir(ART_DIR, { recursive: true });
    return await tmdb.saveImage(url, out);
  } catch (err) {
    log('cover download failed for "' + item.title + '": ' + err.message);
    return null;
  }
}

// Fills in artwork for anything the file system had none for. A cover that the
// file or its .nfo already carries is metadata, so it wins; a frame cut from
// the video is only the last resort.
async function addAutoArtwork(items) {
  for (const item of items) {
    if (!item.posterPath) {
      let poster = await extractEmbeddedCover(item);
      if (!poster) poster = await fetchRemoteArt(item.nfoPosterUrl, item, 'cover');
      if (!poster) poster = await extractFrame(item, 'poster');
      if (poster) item.posterPath = poster;
    }
    if (!item.backdropPath) {
      let backdrop = await fetchRemoteArt(item.nfoBackdropUrl, item, 'fanart');
      if (!backdrop) backdrop = await extractFrame(item, 'backdrop');
      if (backdrop) item.backdropPath = backdrop;
    }
    if (item.kind === 'episode' && !item.thumbPath) {
      const cover = await extractEmbeddedCover(item);
      item.thumbPath = cover || item.posterPath || null;
    }
  }
}

async function runScan() {
  if (state.scanning) {
    // A scan is already walking the libraries; run once more when it finishes
    // so entries added mid-scan are never missed.
    rescanQueued = true;
    return;
  }
  state.scanning = true;
  state.scanDone = 0;
  state.scanTotal = 0;
  const libraries = configStore.read().libraries || [];
  const hiddenPaths = new Set(
    (configStore.read().hidden || []).map((entry) => path.resolve(entry.path).toLowerCase())
  );
  try {
    const all = [];
    const seen = new Set();
    for (const library of libraries) {
      const items = await scanLibrary(library, {
        ffmpeg: FFMPEG,
        probeCache: probeStore.read(),
        hiddenPaths,
        log,
        onProgress: (done, total) => {
          state.scanDone = done;
          state.scanTotal = total;
        },
      });
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        all.push(item);
      }
    }
    const overrides = metadataStore.read();
    for (const item of all) applyOverride(item, overrides[item.path.toLowerCase()]);
    await addAutoArtwork(all);
    libraryStore.write({ items: all, scannedAt: Date.now() });
    libraryStore.flush();
    probeStore.flush();
    reindex();
    log('library ready: ' + all.length + ' video' + (all.length === 1 ? '' : 's'));
  } catch (err) {
    log('scan failed: ' + err.message);
  } finally {
    state.scanning = false;
    state.scanDone = 0;
    state.scanTotal = 0;
    if (rescanQueued) {
      rescanQueued = false;
      setTimeout(runScan, 25);
    }
  }
}

// ---------- http helpers ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.vtt': 'text/vtt; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type) {
  const body = Buffer.from(text);
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > (limit || 1024 * 1024)) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function streamFile(req, res, filePath, mime, cacheControl) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return sendText(res, 404, 'Not found');
  }
  const total = stat.size;
  const range = req.headers.range;
  const headers = {
    'Content-Type': mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl || 'no-cache',
  };

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? Number(match[1]) : 0;
    let end = match && match[2] ? Number(match[2]) : total - 1;
    if (!match) {
      start = 0;
      end = total - 1;
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      return res.end();
    }
    end = Math.min(end, total - 1);
    res.writeHead(206, Object.assign({}, headers, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Content-Length': end - start + 1,
    }));
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  }

  res.writeHead(200, Object.assign({}, headers, { 'Content-Length': total }));
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
}

// ---------- subtitles ----------

const subtitleCache = new Map();

function toVttTime(stamp) {
  // 00:01:02,500 -> 00:01:02.500
  const cleaned = String(stamp).trim().replace(',', '.');
  const parts = cleaned.split(':');
  if (parts.length === 2) return '00:' + parts[0] + ':' + parts[1];
  return cleaned;
}

function srtToVtt(text) {
  const body = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body.trim() + '\n';
}

function assToVtt(text) {
  const cues = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const line of lines) {
    if (!/^Dialogue:/i.test(line)) continue;
    const parts = line.slice(line.indexOf(':') + 1).split(',');
    if (parts.length < 10) continue;
    const start = toVttTime(parts[1]);
    const end = toVttTime(parts[2]);
    const body = parts.slice(9).join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\n/gi, '\n')
      .trim();
    if (!body) continue;
    cues.push(start + ' --> ' + end + '\n' + body);
  }
  return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}

function subtitleVtt(filePath) {
  const key = filePath + ':' + fs.statSync(filePath).mtimeMs;
  if (subtitleCache.has(key)) return subtitleCache.get(key);
  const raw = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  let vtt;
  if (ext === '.vtt') vtt = raw.startsWith('WEBVTT') ? raw : 'WEBVTT\n\n' + raw;
  else if (ext === '.ass' || ext === '.ssa') vtt = assToVtt(raw);
  else vtt = srtToVtt(raw);
  if (subtitleCache.size > 200) subtitleCache.clear();
  subtitleCache.set(key, vtt);
  return vtt;
}

// ---------- playback ----------

function handlePlay(req, res, item, offset, forceTranscode, maxHeight) {
  const info = {
    videoCodec: item.videoCodec,
    audioCodec: item.audioCodec,
    width: item.width || 0,
    height: item.height || 0,
    subtitleStreams: item.subtitleStreams || 0,
  };
  const args = buildPlayArgs(item.path, offset, info, forceTranscode, maxHeight);
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-MattStream-Height': maxHeight ? String(maxHeight) : 'source',
  });

  let child;
  try {
    child = spawn(FFMPEG, args, { windowsHide: true });
  } catch (err) {
    log('could not start ffmpeg: ' + err.message);
    return res.end();
  }

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 4000) stderr += chunk.toString();
  });
  child.stdout.pipe(res);
  child.on('error', (err) => {
    log('ffmpeg failed: ' + err.message);
    res.destroy();
  });
  child.on('close', (code) => {
    if (code && code !== 0 && stderr.trim()) log('ffmpeg exited ' + code + ': ' + stderr.trim().split('\n')[0]);
    if (!res.writableEnded) res.end();
  });
  const stop = () => {
    try { child.kill('SIGKILL'); } catch (err) {}
  };
  req.on('close', stop);
  res.on('close', stop);
}

// ---------- folder browser (for adding libraries in the UI) ----------

async function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = String.fromCharCode(code) + ':\\';
    try {
      if (fs.existsSync(drive)) drives.push(drive);
    } catch (err) {}
  }
  return drives;
}

async function browse(target) {
  let dir = target ? path.resolve(target) : '';
  if (!dir) {
    const home = os.homedir();
    const showcase = [path.join(home, 'Videos'), path.join(home, 'Movies'), path.join(home, 'Downloads')]
      .filter((candidate) => fs.existsSync(candidate));
    return {
      path: '',
      shows: showcase,
      dirs: await Promise.all(
        (await listDrives()).map(async (drive) => ({ name: drive, path: drive }))
      ),
      files: [],
      parent: null,
    };
  }

  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    const error = new Error('Not a folder: ' + dir);
    error.status = 400;
    throw error;
  }

  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('$') && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
    .sort(byName);

  // Video files can be added on their own, not just whole folders.
  const files = entries
    .filter((entry) => entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch (err) {
        size = 0;
      }
      return { name: entry.name, path: full, size, sizeLabel: prettySize(size) };
    })
    .sort(byName);

  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? '' : parent,
    dirs,
    files,
    shows: [],
  };
}

// ---------- request routing ----------

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/status') {
    const libraries = configStore.read().libraries || [];
    const port = currentPort;
    return sendJson(res, 200, {
      version: VERSION,
      scanning: state.scanning,
      scanDone: state.scanDone,
      scanTotal: state.scanTotal,
      ffmpeg: state.ffmpegOk,
      libraries,
      hidden: configStore.read().hidden || [],
      lanUrls: lanUrls(port),
      port,
      videos: byId.size,
      uptime: Math.round((Date.now() - state.startedAt) / 1000),
      admin: isAdmin(req),
      serverName: os.hostname(),
      tmdb: Boolean(tmdb.apiKey(configStore)),
      log: state.log.slice(-20),
    });
  }

  // Which server this installation treats as its own library.
  if (route === '/api/defaults') {
    return sendJson(res, 200, readDefaults());
  }

  if (route === '/api/library') {
    const data = libraryStore.read();
    return sendJson(res, 200, {
      items: data.items || [],
      scannedAt: data.scannedAt || 0,
      scanning: state.scanning,
      progress: { done: state.scanDone, total: state.scanTotal },
    });
  }

  if (route === '/api/progress' && req.method === 'GET') {
    return sendJson(res, 200, progressStore.read());
  }

  if (route.startsWith('/api/progress/')) {
    const id = decodeURIComponent(route.slice('/api/progress/'.length));
    if (req.method === 'POST') {
      const body = await readBody(req);
      const duration = Number(body.duration) || 0;
      const position = Math.max(0, Number(body.position) || 0);
      progressStore.update((data) => {
        if (!byId.has(id)) return;
        if (duration && position / duration > 0.96) {
          delete data[id]; // finished: drop out of Continue Watching
          return;
        }
        data[id] = { position: Math.round(position), duration: Math.round(duration), updated: Date.now() };
      });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      progressStore.update((data) => { delete data[id]; });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (route === '/api/admin') {
    const admin = isAdmin(req);
    return sendJson(res, 200, {
      admin,
      key: admin ? adminKey() : null,
      serverName: os.hostname(),
      lanUrls: lanUrls(currentPort),
      port: currentPort,
    });
  }

  if (route === '/api/scan' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    if (!state.scanning) runScan();
    return sendJson(res, 200, { started: true });
  }

  if (route === '/api/libraries' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const targets = Array.isArray(body.paths) && body.paths.length ? body.paths : [body.path];
    const added = [];
    const errors = [];

    for (const raw of targets) {
      const target = String(raw || '').trim();
      if (!target) continue;

      const stat = await fsp.stat(target).catch(() => null);
      if (!stat) {
        errors.push({ path: target, error: "MattStream can't find: " + target });
        continue;
      }

      const isFile = stat.isFile();
      if (isFile && !VIDEO_EXT.has(path.extname(target).toLowerCase())) {
        errors.push({ path: target, error: 'That is not a video file MattStream can read.' });
        continue;
      }

      const resolved = path.resolve(target);
      const libraries = configStore.read().libraries || [];
      if (libraries.some((lib) => path.resolve(lib.path).toLowerCase() === resolved.toLowerCase())) {
        errors.push({ path: target, error: 'Already in your library.' });
        continue;
      }

      const defaultName = isFile
        ? path.basename(resolved, path.extname(resolved))
        : path.basename(resolved);
      const library = {
        id: crypto.createHash('sha1').update(resolved.toLowerCase()).digest('hex').slice(0, 10),
        name: String(body.name || '').trim() || defaultName || resolved,
        path: resolved,
        kind: isFile ? 'file' : 'folder',
        addedAt: Date.now(),
      };
      configStore.update((data) => {
        data.libraries = (data.libraries || []).concat(library);
      });
      added.push(library);
      log('added library "' + library.name + '" (' + library.path + ')');
    }

    if (!targets.filter((t) => String(t || '').trim()).length) {
      return sendJson(res, 400, { error: 'Choose a folder or a video file first.' });
    }
    if (!added.length && errors.length) return sendJson(res, 400, { error: errors[0].error, errors });

    configStore.flush();
    if (added.length) runScan();
    return sendJson(res, 200, { library: added[0] || null, libraries: added, errors });
  }

  if (route.startsWith('/api/libraries/') && req.method === 'DELETE') {
    if (!requireAdmin(res, req)) return;
    const id = decodeURIComponent(route.slice('/api/libraries/'.length));
    configStore.update((data) => {
      data.libraries = (data.libraries || []).filter((lib) => lib.id !== id);
    });
    configStore.flush();
    libraryStore.update((data) => {
      data.items = (data.items || []).filter((item) => item.libraryId !== id);
    });
    libraryStore.flush();
    reindex();
    log('removed a library entry');
    return sendJson(res, 200, { ok: true });
  }

  // Remove a video from the shelf. Never deletes the file itself.
  if (route === '/api/hide' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const item = byId.get(String(body.id || ''));
    if (!item) return sendJson(res, 404, { error: 'That video is no longer in the library.' });
    const lower = path.resolve(item.path).toLowerCase();
    let droppedEntry = false;

    configStore.update((data) => {
      const libraries = data.libraries || [];
      const entry = libraries.find((lib) => path.resolve(lib.path).toLowerCase() === lower);
      if (entry) {
        // It was added as its own file entry, so removing the entry is enough.
        data.libraries = libraries.filter((lib) => lib !== entry);
        droppedEntry = true;
        return;
      }
      const hidden = data.hidden || [];
      if (!hidden.some((h) => path.resolve(h.path).toLowerCase() === lower)) {
        hidden.push({
          path: item.path,
          title: item.kind === 'episode' ? item.series + ' \u00b7 ' + item.title : item.title,
          hiddenAt: Date.now(),
        });
      }
      data.hidden = hidden;
    });
    configStore.flush();

    libraryStore.update((data) => {
      data.items = (data.items || []).filter((it) => it.id !== item.id);
    });
    libraryStore.flush();
    reindex();
    log('removed "' + item.title + '" from the shelf (file untouched)');
    return sendJson(res, 200, { ok: true, droppedEntry });
  }

  if (route === '/api/unhide' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const target = path.resolve(String(body.path || '')).toLowerCase();
    configStore.update((data) => {
      data.hidden = (data.hidden || []).filter((h) => path.resolve(h.path).toLowerCase() !== target);
    });
    configStore.flush();
    runScan();
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/browse') {
    const target = url.searchParams.get('path') || '';
    return sendJson(res, 200, await browse(target));
  }

  if (route.startsWith('/api/stream/')) {
    const id = decodeURIComponent(route.slice('/api/stream/'.length));
    const item = byId.get(id);
    if (!item) return sendText(res, 404, 'Unknown video');
    const mime = MIME[path.extname(item.path).toLowerCase()] || 'video/mp4';
    return streamFile(req, res, item.path, mime, 'no-cache');
  }

  if (route.startsWith('/api/play/')) {
    const id = decodeURIComponent(route.slice('/api/play/'.length));
    const item = byId.get(id);
    if (!item) return sendText(res, 404, 'Unknown video');
    const offset = Number(url.searchParams.get('t') || 0);
    const force = url.searchParams.get('force') === '1';
    const maxHeight = Math.max(0, Math.min(2160, Math.floor(Number(url.searchParams.get('h') || 0))));
    // A chosen quality goes through ffmpeg so the picture really is smaller.
    if (item.playback === 'direct' && !force && !maxHeight) {
      res.writeHead(302, { Location: '/api/stream/' + encodeURIComponent(id) });
      return res.end();
    }
    return handlePlay(req, res, item, offset, force, maxHeight);
  }

  if (route.startsWith('/api/art/')) {
    const id = decodeURIComponent(route.slice('/api/art/'.length));
    const item = byId.get(id);
    if (!item) return sendText(res, 404, 'Not found');
    const kindParam = url.searchParams.get('k');
    const kind = kindParam === 'backdrop' ? 'backdropPath' : kindParam === 'thumb' ? 'thumbPath' : 'posterPath';
    const file = item[kind];
    if (!file) return sendText(res, 404, 'No artwork');
    const mime = MIME[path.extname(file).toLowerCase()] || 'image/jpeg';
    return streamFile(req, res, file, mime, 'public, max-age=3600');
  }

  if (route === '/api/subtitles') {
    const id = url.searchParams.get('i') || '';
    const index = Number(url.searchParams.get('s') || 0);
    const item = byId.get(id);
    if (!item || !item.subtitles || !item.subtitles[index]) return sendText(res, 404, 'No subtitle');
    const subPath = item.subtitles[index].path;
    try {
      const vtt = subtitleVtt(subPath);
      return sendText(res, 200, vtt, 'text/vtt; charset=utf-8');
    } catch (err) {
      return sendText(res, 500, 'Could not read subtitle');
    }
  }

  // Upload a real video file into an added folder. The bytes are streamed
  // straight to disk, so the progress the app shows is the actual transfer.
  if (route === '/api/upload' && req.method === 'PUT') {
    if (!requireAdmin(res, req)) return;
    const libraryId = url.searchParams.get('libraryId') || '';
    const library = (configStore.read().libraries || []).find((lib) => lib.id === libraryId);
    if (!library) return sendJson(res, 400, { error: 'Pick a folder in your library to upload into.' });
    if (library.kind !== 'folder') return sendJson(res, 400, { error: 'Uploads go into an added folder.' });

    const safeName = path
      .basename(String(url.searchParams.get('name') || ''))
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .trim();
    if (!safeName || !VIDEO_EXT.has(path.extname(safeName).toLowerCase())) {
      return sendJson(res, 400, { error: 'That is not a video file MattStream can read.' });
    }

    let target = path.join(library.path, safeName);
    let counter = 1;
    while (fs.existsSync(target)) {
      const ext = path.extname(safeName);
      target = path.join(library.path, path.basename(safeName, ext) + ' (' + counter + ')' + ext);
      counter += 1;
    }

    const temp = target + '.part';
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(temp);
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
      const partial = await fsp.stat(temp).catch(() => null);
      if (!partial || !partial.size) throw new Error('The upload was empty.');
      await fsp.rename(temp, target);
    } catch (err) {
      await fsp.unlink(temp).catch(() => {});
      return sendJson(res, 500, { error: 'Upload failed: ' + err.message });
    }

    const stat = await fsp.stat(target).catch(() => null);
    log('uploaded "' + safeName + '" into ' + library.name);
    runScan();
    return sendJson(res, 200, {
      ok: true,
      path: target,
      name: path.basename(target),
      size: stat ? stat.size : 0,
      sizeLabel: prettySize(stat ? stat.size : 0),
    });
  }

  // Permanently delete the media file. The caller has to type its name first.
  if (route === '/api/media/delete' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const item = byId.get(String(body.id || ''));
    if (!item) return sendJson(res, 404, { error: 'That video is no longer in the library.' });

    const fileName = path.basename(item.path);
    if (String(body.confirm || '') !== fileName) {
      return sendJson(res, 400, { error: 'Type the file name exactly to confirm the delete.' });
    }

    try {
      await fsp.unlink(item.path);
    } catch (err) {
      return sendJson(res, 500, { error: 'Could not delete the file: ' + err.message });
    }

    const override = metadataStore.read()[item.path.toLowerCase()] || {};
    for (const key of ['posterPath', 'backdropPath', 'thumbPath']) {
      const file = override[key];
      if (file && path.resolve(file).startsWith(ART_DIR)) await fsp.unlink(file).catch(() => {});
    }
    for (const suffix of ['-poster.jpg', '-backdrop.jpg']) {
      for (const extra of [
        'auto-' + item.id + suffix,
        'cover-' + item.id + '.jpg',
        'cover-' + item.id + '.png',
        'fanart-' + item.id + '.jpg',
        'fanart-' + item.id + '.png',
        'match-' + item.id + '-poster.jpg',
        'match-' + item.id + '-backdrop.jpg',
      ]) {
        await fsp.unlink(path.join(ART_DIR, extra)).catch(() => {});
      }
    }

    probeStore.update((data) => {
      delete data[item.path];
    });
    probeStore.flush();
    progressStore.update((data) => {
      delete data[item.id];
    });
    progressStore.flush();
    metadataStore.update((data) => {
      delete data[item.path.toLowerCase()];
    });
    metadataStore.flush();
    libraryStore.update((data) => {
      data.items = (data.items || []).filter((entry) => entry.id !== item.id);
    });
    libraryStore.flush();
    configStore.update((data) => {
      data.libraries = (data.libraries || []).filter(
        (lib) => path.resolve(lib.path).toLowerCase() !== path.resolve(item.path).toLowerCase()
      );
      data.hidden = (data.hidden || []).filter(
        (entry) => path.resolve(entry.path).toLowerCase() !== path.resolve(item.path).toLowerCase()
      );
    });
    configStore.flush();
    reindex();
    log('DELETED file "' + item.path + '"');
    return sendJson(res, 200, { ok: true, deleted: item.path });
  }

  // Hand-edited details for one item.
  if (route === '/api/metadata' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const item = byId.get(String(body.id || ''));
    if (!item) return sendJson(res, 404, { error: 'That video is no longer in the library.' });

    const patch = {};
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
    if (typeof body.series === 'string' && body.series.trim()) patch.series = body.series.trim();
    if (typeof body.overview === 'string') patch.overview = body.overview.trim();
    if (Number(body.year)) patch.year = Math.round(Number(body.year));
    if (Number(body.runtime)) patch.runtime = Math.round(Number(body.runtime));
    if (Array.isArray(body.genres)) {
      patch.genres = body.genres.map((genre) => String(genre).trim()).filter(Boolean).slice(0, 8);
    } else if (typeof body.genres === 'string') {
      patch.genres = body.genres.split(',').map((genre) => genre.trim()).filter(Boolean).slice(0, 8);
    }

    const key = item.path.toLowerCase();
    metadataStore.update((data) => {
      data[key] = Object.assign({}, data[key] || {}, patch);
    });
    metadataStore.flush();
    applyOverride(item, patch);
    libraryStore.update((data) => {
      const stored = (data.items || []).find((entry) => entry.id === item.id);
      if (stored) Object.assign(stored, item);
    });
    libraryStore.flush();
    reindex();
    log('updated details for "' + item.title + '"');
    return sendJson(res, 200, { ok: true, item });
  }

  // Re-probe one file from scratch (picks up new .nfo files and artwork).
  if (route === '/api/refresh' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const item = byId.get(String(body.id || ''));
    if (!item) return sendJson(res, 404, { error: 'That video is no longer in the library.' });
    probeStore.update((data) => {
      delete data[item.path];
    });
    probeStore.flush();
    runScan();
    return sendJson(res, 200, { ok: true, scanning: true });
  }

  // Custom poster / backdrop / thumbnail for one item.
  if (route === '/api/artwork' && req.method === 'PUT') {
    if (!requireAdmin(res, req)) return;
    const item = byId.get(url.searchParams.get('id') || '');
    if (!item) return sendJson(res, 404, { error: 'That video is no longer in the library.' });

    const kindParam = url.searchParams.get('kind');
    const kind = kindParam === 'backdrop' || kindParam === 'thumb' ? kindParam : 'poster';
    const type = String(req.headers['content-type'] || '');
    const ext = /png/i.test(type) ? '.png' : /webp/i.test(type) ? '.webp' : /jpe?g/i.test(type) ? '.jpg' : '';
    if (!ext) return sendJson(res, 400, { error: 'Send a JPG, PNG or WebP image.' });

    await fsp.mkdir(ART_DIR, { recursive: true });
    const file = path.join(ART_DIR, item.id + '-' + kind + ext);
    const limit = 25 * 1024 * 1024;
    let written = 0;

    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file);
        req.on('data', (chunk) => {
          written += chunk.length;
          if (written > limit) {
            req.destroy();
            reject(new Error('Image is larger than 25 MB.'));
          }
        });
        req.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
    } catch (err) {
      await fsp.unlink(file).catch(() => {});
      return sendJson(res, 400, { error: err.message });
    }
    if (!written) {
      await fsp.unlink(file).catch(() => {});
      return sendJson(res, 400, { error: 'That image was empty.' });
    }

    const key = item.path.toLowerCase();
    const field = kind + 'Path';
    metadataStore.update((data) => {
      data[key] = Object.assign({}, data[key] || {}, { [field]: file });
    });
    metadataStore.flush();
    item[field] = file;
    libraryStore.update((data) => {
      const stored = (data.items || []).find((entry) => entry.id === item.id);
      if (stored) stored[field] = file;
    });
    libraryStore.flush();
    reindex();
    log('new ' + kind + ' for "' + item.title + '"');
    return sendJson(res, 200, { ok: true, kind, url: '/api/art/' + encodeURIComponent(item.id) + '?k=' + kind });
  }

  // ---- cast to another screen ----
  // Each screen holds this open; a cast command is written straight down it.
  if (route === '/api/cast/events') {
    const clientId = String(url.searchParams.get('client') || '');
    const name = String(url.searchParams.get('name') || 'A screen').slice(0, 40);
    if (!clientId) return sendText(res, 400, 'Missing client');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    try {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
    } catch (err) {
      /* older socket */
    }

    castClients.set(clientId, { id: clientId, name, res, since: Date.now() });
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (err) {
        /* the screen went away; the close handler clears it */
      }
    }, 20000);
    const drop = () => {
      clearInterval(ping);
      const current = castClients.get(clientId);
      if (current && current.res === res) {
        castClients.delete(clientId);
        castSessions.delete(clientId);
      }
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('close', drop);
    return;
  }

  // Remote control while a cast is running.
  if (route === '/api/cast/command' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const targetId = String(body.target || '');
    const action = String(body.action || '');
    const value = Number(body.value);
    if (!['play', 'pause', 'seek', 'speed', 'stop'].includes(action)) {
      return sendJson(res, 400, { error: 'Unknown command' });
    }
    const target = castClients.get(targetId);
    if (!target) return sendJson(res, 404, { error: 'That screen is not connected any more.' });

    const command = { type: 'command', action };
    if (Number.isFinite(value)) command.value = value;
    try {
      target.res.write('data: ' + JSON.stringify(command) + '\n\n');
    } catch (err) {
      return sendJson(res, 409, { error: 'That screen dropped off.' });
    }

    const session = castSessions.get(targetId);
    if (session) {
      if (action === 'play') session.paused = false;
      if (action === 'pause') session.paused = true;
      if (action === 'seek') session.position = value;
      if (action === 'speed') session.speed = value;
      session.updatedAt = Date.now();
    }
    if (action === 'stop') castSessions.delete(targetId);
    return sendJson(res, 200, { ok: true });
  }

  // The screen playing the film reports where it is, every couple of seconds.
  if (route === '/api/cast/report' && req.method === 'POST') {
    const body = await readBody(req);
    const targetId = String(body.target || '');
    if (!castClients.has(targetId)) return sendJson(res, 404, { error: 'Unknown screen' });
    if (!castSessions.has(targetId)) return sendJson(res, 409, { error: 'No cast running' });
    castSessions.set(targetId, {
      targetId,
      itemId: String(body.itemId || ''),
      paused: Boolean(body.paused),
      position: Number(body.position) || 0,
      duration: Number(body.duration) || 0,
      speed: Number(body.speed) || 1,
      updatedAt: Date.now(),
    });
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/cast/state') {
    const targetId = String(url.searchParams.get('target') || '');
    const session = castSessions.get(targetId) || null;
    return sendJson(res, 200, { session, connected: castClients.has(targetId) });
  }

  if (route === '/api/network') {
    // Addresses a TV or phone can be pointed at. The tunnel is read from the
    // log because the URL is only known once cloudflared has registered.
    return sendJson(res, 200, {
      port: currentPort,
      lan: lanUrls(currentPort),
      tunnel: tunnelUrl(),
      firewall: firewallAllows(),
    });
  }

  if (route === '/api/cast/targets') {
    const self = String(url.searchParams.get('client') || '');
    return sendJson(res, 200, {
      targets: Array.from(castClients.values())
        .filter((entry) => entry.id !== self && !entry.res.destroyed && !entry.res.writableEnded)
        .map((entry) => ({ id: entry.id, name: entry.name })),
    });
  }

  if (route === '/api/cast' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const target = castClients.get(String(body.client || ''));
    if (!target) return sendJson(res, 404, { error: 'That screen is not connected any more.' });
    const item = byId.get(String(body.itemId || ''));
    if (!item) return sendJson(res, 404, { error: 'That video is no longer in the library.' });

    const payload = {
      type: 'cast',
      itemId: item.id,
      title: item.title,
      from: String(body.from || ''),
      fromName: String(body.fromName || 'MattStream').slice(0, 40),
    };
    try {
      target.res.write('data: ' + JSON.stringify(payload) + '\n\n');
    } catch (err) {
      castClients.delete(target.id);
      return sendJson(res, 409, { error: 'That screen dropped off - try Refresh.' });
    }
    castSessions.set(target.id, {
      targetId: target.id,
      itemId: item.id,
      paused: false,
      position: 0,
      duration: Number(item.duration) || 0,
      speed: 1,
      updatedAt: Date.now(),
    });
    log('casting "' + item.title + '" to ' + target.name);
    return sendJson(res, 200, { ok: true, target: target.name });
  }

  // Identify a file against real metadata and show the candidates.
  if (route === '/api/match/search' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const item = byId.get(String(body.id || ''));
    if (!item) return sendJson(res, 404, { error: 'That video is no longer in the library.' });

    const key = tmdb.apiKey(configStore);
    if (!key) {
      return sendJson(res, 400, {
        error: 'Add a TMDB API key to fetch real titles and posters.',
        needsKey: true,
      });
    }
    const guessed = tmdb.guessFromFilename(item);
    const query = String(body.query || guessed.title || item.title || '').trim();
    if (!query) return sendJson(res, 400, { error: 'Give MattStream a name to search for.' });

    try {
      const candidates = await tmdb.search({ key, query, year: guessed.year, kind: item.kind });
      return sendJson(res, 200, { query, candidates });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  // The TMDB key lives on the server, never in the page.
  if (route === '/api/match/key' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const key = String(body.key || '').trim();
    if (!/^[a-f0-9]{32}$/i.test(key)) {
      return sendJson(res, 400, { error: 'That does not look like a TMDB v3 key (32 letters and numbers).' });
    }
    configStore.update((data) => {
      data.tmdbKey = key;
    });
    configStore.flush();
    log('saved a TMDB key for metadata matching');
    return sendJson(res, 200, { ok: true });
  }

  // Save the chosen match: that entry's own title, year, plot and artwork.
  if (route === '/api/match/apply' && req.method === 'POST') {
    if (!requireAdmin(res, req)) return;
    const body = await readBody(req);
    const item = byId.get(String(body.id || ''));
    if (!item) return sendJson(res, 404, { error: 'That video is no longer in the library.' });

    const key = tmdb.apiKey(configStore);
    if (!key) return sendJson(res, 400, { error: 'Add a TMDB API key first.', needsKey: true });

    let chosen;
    try {
      chosen = await tmdb.details({ key, tmdbId: body.tmdbId, mediaType: body.mediaType });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
    if (!chosen || !chosen.title) return sendJson(res, 502, { error: 'That match had no usable metadata.' });

    const applyToSeries = body.scope === 'series' && item.kind === 'episode' && item.series;
    const targets = applyToSeries
      ? (libraryStore.read().items || []).filter(
          (entry) => entry.kind === 'episode' && entry.series === item.series
        )
      : [item];
    if (!targets.length) targets.push(item);

    await fsp.mkdir(ART_DIR, { recursive: true });
    const poster = await tmdb
      .saveImage(chosen.posterUrl, path.join(ART_DIR, 'match-' + item.id + '-poster.jpg'))
      .catch((err) => {
        log('poster download failed: ' + err.message);
        return null;
      });
    const backdrop = await tmdb
      .saveImage(chosen.backdropUrl, path.join(ART_DIR, 'match-' + item.id + '-backdrop.jpg'))
      .catch(() => null);

    const patch = {
      overview: chosen.overview,
      tmdbId: chosen.tmdbId,
      mediaType: chosen.mediaType,
      matchedAt: Date.now(),
    };
    if (chosen.year) patch.year = chosen.year;
    if (chosen.runtime) patch.runtime = chosen.runtime;
    if (chosen.genres && chosen.genres.length) patch.genres = chosen.genres;
    if (poster) patch.posterPath = poster;
    if (backdrop) patch.backdropPath = backdrop;

    const ids = new Set(targets.map((entry) => entry.id));
    metadataStore.update((data) => {
      for (const target of targets) {
        const stored = Object.assign({}, data[target.path.toLowerCase()] || {});
        Object.assign(stored, patch);
        if (target.kind === 'episode') stored.series = chosen.title;
        else stored.title = chosen.title;
        data[target.path.toLowerCase()] = stored;
      }
    });
    metadataStore.flush();

    libraryStore.update((data) => {
      for (const entry of data.items || []) {
        if (!ids.has(entry.id)) continue;
        const override = Object.assign({}, patch);
        if (entry.kind === 'episode') override.series = chosen.title;
        else override.title = chosen.title;
        applyOverride(entry, override);
      }
    });
    libraryStore.flush();
    reindex();
    log('matched "' + (item.kind === 'episode' ? item.series : item.title) + '" to ' + chosen.title);
    return sendJson(res, 200, { ok: true, matched: chosen.title, items: targets.length });
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

function serveWeb(req, res, pathname) {
  const allowed = new Set([
    '/index.html',
    '/app.js',
    '/manage.js',
    '/match.js',
    '/cast.js',
    '/styles.css',
    '/icon.svg',
    '/manifest.webmanifest',
  ]);
  let target = pathname === '/' ? '/index.html' : pathname;
  if (!allowed.has(target)) target = '/index.html'; // SPA fallback for deep links
  const file = path.join(WEB_DIR, target);
  if (!file.startsWith(WEB_DIR)) return sendText(res, 403, 'Forbidden');
  const mime = MIME[path.extname(file).toLowerCase()] || 'text/plain';
  return streamFile(req, res, file, mime, 'no-cache');
}

let currentPort = 8096;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (url.pathname.startsWith('/api/')) {
      // The app can test and talk to this server from another origin (the
      // Server Connection page points at LAN addresses), so answer CORS.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MattStream-Key');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET,POST,PUT,DELETE,OPTIONS' });
        return res.end();
      }
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    return serveWeb(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    else res.destroy();
  }
});

function openBrowser(target) {
  const command =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (err) {
    /* the address is printed either way */
  }
}

// True when something that answers like MattStream already owns the port.
function mattstreamIsRunning() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const probe = http.get(
      { host: '127.0.0.1', port: currentPort, path: '/api/status', timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          if (body.length < 4000) body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            finish(Boolean(parsed && parsed.version && parsed.lanUrls));
          } catch (err) {
            finish(false);
          }
        });
      }
    );
    probe.on('timeout', () => {
      probe.destroy();
      finish(false);
    });
    probe.on('error', () => finish(false));
  });
}

function resolvePort() {
  const fromArgs = process.argv.find((arg) => arg.startsWith('--port='));
  const candidate = Number(
    (fromArgs && fromArgs.split('=')[1]) || process.env.PORT || configStore.read().port || 8096
  );
  return Number.isFinite(candidate) && candidate > 0 && candidate < 65536 ? candidate : 8096;
}

async function start() {
  currentPort = resolvePort();
  reindex();
  state.ffmpegOk = await ffmpegWorks(FFMPEG);

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      // Double-clicking the shortcut twice should take you to the running server, not an error.
      const ours = await mattstreamIsRunning();
      if (ours) {
        console.log('\n  MattStream is already running at http://localhost:' + currentPort);
        if (process.argv.includes('--open')) {
          openBrowser('http://localhost:' + currentPort);
          console.log('  Opened it in your browser.\n');
        } else {
          console.log('  Just open that address to watch.\n');
        }
        process.exit(0);
        return;
      }
      console.error('\n  Port ' + currentPort + ' is already in use by another program.');
      console.error('  Start MattStream on another port:  node server/index.js --port=' + (currentPort + 1) + '\n');
      process.exit(1);
      return;
    }
    console.error('[mattstream] server error: ' + err.message);
  });

  return new Promise((resolve) => {
    server.listen(currentPort, '0.0.0.0', () => {
      const lines = [
        '',
        '  MATTSTREAM  v' + VERSION,
        '  ------------------------------------------------',
        '  Playing from  ' + (configStore.read().libraries.length || 0) + ' library folder(s)',
        '  This computer  http://localhost:' + currentPort,
      ];
      for (const url of lanUrls(currentPort)) lines.push('  Your network   ' + url);
      lines.push(
        '  FFmpeg         ' + (state.ffmpegOk ? 'ready (' + FFMPEG + ')' : 'NOT FOUND - only browser-native video will play'),
        '',
        '  Leave this window open while you watch.  Press Ctrl+C to stop.',
        ''
      );
      console.log(lines.join('\n'));
      log('server listening on port ' + currentPort);

      if (process.argv.includes('--open')) openBrowser('http://localhost:' + currentPort);
      if ((configStore.read().libraries || []).length) runScan();
      resolve({ port: currentPort });
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server.listening) return resolve(false);
    server.close(() => resolve(true));
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

process.on('SIGINT', () => {
  log('shutting down');
  configStore.flush();
  libraryStore.flush();
  progressStore.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800);
});

// Started directly from a terminal: run the server and wait.
// Imported by the desktop app: the caller decides when to start.
if (require.main === module) {
  start();
}

module.exports = { start, stop, lanUrls, port: () => currentPort, appRoot: APP_ROOT };
