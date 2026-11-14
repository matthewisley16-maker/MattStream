'use strict';

// Walks your folders, reads the files, and turns them into a browsable library.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { probe, playbackMode } = require('./media');

const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv', '.ts', '.m2ts',
  '.mts', '.mpg', '.mpeg', '.ogv', '.vob', '.divx', '.3gp', '.rmvb', '.rm', '.asf',
  '.f4v', '.ogm', '.mxf', '.wtv',
]);

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

const SUB_EXT = new Map([
  ['.srt', 'srt'],
  ['.vtt', 'vtt'],
  ['.ass', 'ass'],
  ['.ssa', 'ssa'],
  ['.sub', 'sub'],
]);

const POSTER_NAMES = ['poster', 'folder', 'cover', 'movie', 'show', 'poster1'];
const BACKDROP_NAMES = ['backdrop', 'fanart', 'background', 'banner', 'thumb'];

const SKIP_DIRS = new Set([
  'node_modules', '$recycle.bin', 'system volume information', '@eadir', '.git',
  'lost+found', '.trash', '.cache', 'recycler',
]);

const LANG_NAMES = {
  en: 'English', eng: 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French',
  de: 'German', ger: 'German', it: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  ru: 'Russian', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean',
  zh: 'Chinese', chi: 'Chinese', ar: 'Arabic', hi: 'Hindi', nl: 'Dutch', pl: 'Polish',
  tr: 'Turkish', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish',
  cs: 'Czech', el: 'Greek', he: 'Hebrew', hu: 'Hungarian', id: 'Indonesian',
  ro: 'Romanian', th: 'Thai', uk: 'Ukrainian', vi: 'Vietnamese',
};

// Words that only ever appear in release names, never in a real title.
const STRONG_TAGS = [
  '2160p', '1440p', '1080p', '720p', '576p', '480p', '4k', 'uhd', 'bluray', 'blu-ray',
  'brrip', 'bdrip', 'dvdrip', 'dvdscr', 'webrip', 'web-dl', 'webdl', 'web', 'hdtv',
  'pdtv', 'hdrip', 'remux', 'hdcam', 'x264', 'x265', 'h264', 'h265', 'hevc', 'avc',
  'xvid', 'divx', 'av1', 'vp9', '10bit', '8bit', 'hdr10', 'hdr', 'dolbyvision', 'dtshd',
  'dts', 'truehd', 'atmos', 'eac3', 'ac3', 'aac', 'flac', 'opus', 'ddp5 1', 'dd5 1',
  'proper', 'repack', 'extended', 'unrated', 'remastered', 'directors cut', 'multi',
];

const TAG_REGEX = new RegExp(
  '(?:^|\\s)(' +
    STRONG_TAGS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    ')(?=\\s|$)',
  'i'
);

const EPISODE_PATTERNS = [
  { re: /\bs(\d{1,2})\s*e(\d{1,3})\b/i, season: 1, episode: 2 },
  { re: /\b(\d{1,2})x(\d{2,3})\b/i, season: 1, episode: 2 },
  { re: /\bseason\s*(\d{1,2})\s*[-_ ]?\s*episode\s*(\d{1,3})\b/i, season: 1, episode: 2 },
  { re: /\bepisode\s*(\d{1,3})\b/i, season: null, episode: 1 },
  { re: /\bep\s*(\d{1,3})\b/i, season: null, episode: 1 },
];

function idFor(filePath) {
  return crypto.createHash('sha1').update(filePath.toLowerCase()).digest('hex').slice(0, 16);
}

function tidy(text) {
  return String(text || '')
    .replace(/[._]+/g, ' ')
    .replace(/[\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:|,]+/, '')
    .replace(/[\s\-–—:|,]+$/, '')
    .trim();
}

function stripReleaseGroup(text) {
  const match = /^(.*?)(?:\s+-\s*|\s*-|[-_])([A-Za-z0-9]{2,24})$/.exec(text);
  if (!match) return text;
  if (match[2].length < 4) return text;
  if (!match[1].includes(' ')) return text;
  return match[1].trim();
}

function cutAtReleaseTags(text) {
  const match = TAG_REGEX.exec(text);
  if (!match || match.index === 0) return text;
  return text.slice(0, match.index).trim();
}

function findEpisode(text) {
  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    const season = pattern.season ? Number(match[pattern.season]) : 1;
    const episode = Number(match[pattern.episode]);
    if (!Number.isFinite(episode) || episode <= 0) continue;
    return {
      index: match.index,
      length: match[0].length,
      season: Number.isFinite(season) && season > 0 ? season : 1,
      episode,
    };
  }
  return null;
}

// Turns a file name into something a person recognises.
function parseMediaName(fileName) {
  let base = path.basename(String(fileName), path.extname(String(fileName)));
  base = base.replace(/\[[^\]]*\]/g, ' ');
  base = base.replace(/[._]+/g, ' ');
  base = base.replace(/\s+/g, ' ').trim();
  base = stripReleaseGroup(base);
  base = cutAtReleaseTags(base);
  base = tidy(base);

  const episode = findEpisode(base);
  if (episode) {
    let series = tidy(base.slice(0, episode.index));
    let episodeTitle = tidy(
      stripReleaseGroup(base.slice(episode.index + episode.length)).replace(/^[-–—:|]\s*/, '')
    );
    return {
      kind: 'episode',
      series,
      season: episode.season,
      episode: episode.episode,
      episodeTitle,
      title: series,
      year: null,
    };
  }

  const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(base);
  let year = null;
  let title = base;
  if (yearMatch) {
    year = Number(yearMatch[1]);
    const before = tidy(base.slice(0, yearMatch.index));
    if (before.length >= 2) title = before;
  }
  title = tidy(title) || tidy(path.basename(path.dirname(fileName)));
  return { kind: 'movie', title, series: null, season: null, episode: null, year };
}

function sortTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

function prettySize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[unit];
}

// ---------- filesystem walk ----------

function bucketFor(collected, dir) {
  const bucket = collected.get(dir) || { videos: [], images: [], subs: [] };
  collected.set(dir, bucket);
  return bucket;
}

function classifyFile(bucket, full) {
  const ext = path.extname(full).toLowerCase();
  if (VIDEO_EXT.has(ext)) bucket.videos.push(full);
  else if (IMAGE_EXT.has(ext)) bucket.images.push(full);
  else if (SUB_EXT.has(ext)) bucket.subs.push(full);
}

// Reads one folder without recursing, so a single added file still gets its
// neighbours' artwork and subtitles.
async function readDirectoryInto(dir, collected) {
  const bucket = bucketFor(collected, dir);
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile()) classifyFile(bucket, path.join(dir, entry.name));
  }
  return bucket;
}

async function walkDirectory(dir, collected, depth) {
  if (depth > 10) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  const bucket = bucketFor(collected, dir);

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const lower = entry.name.toLowerCase();
      if (entry.name.startsWith('.') || SKIP_DIRS.has(lower)) continue;
      await walkDirectory(full, collected, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue; // ignore symlinks and special files
    classifyFile(bucket, full);
  }
}

function pickImage(images, preferred) {
  if (!images || !images.length) return null;
  for (const name of preferred) {
    const hit = images.find(
      (img) => path.basename(img, path.extname(img)).toLowerCase() === name
    );
    if (hit) return hit;
  }
  return null;
}

// Artwork can sit beside the file, in a season folder above it, or at the show root.
function findArt(collected, dir, preferred) {
  let current = dir;
  for (let level = 0; level < 3; level += 1) {
    const bucket = collected.get(current);
    if (bucket) {
      const hit = pickImage(bucket.images, preferred);
      if (hit) return hit;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const own = collected.get(dir);
  if (own && own.images.length) return own.images[0];
  return null;
}

function subtitleLanguage(fileName) {
  const base = path.basename(fileName, path.extname(fileName)).toLowerCase();
  const parts = base.split(/[.\s_-]+/).filter(Boolean);
  const skip = new Set(['forced', 'default', 'sdh', 'cc', 'sdhsub', 'subs', 'full']);
  // Walk backwards: language tags sit at the end, before flags like ".forced".
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const token = parts[i];
    if (skip.has(token)) continue;
    if (LANG_NAMES[token]) return { code: token, label: LANG_NAMES[token] };
    if (/^[a-z]{2}$/.test(token)) return { code: token, label: token.toUpperCase() };
  }
  return { code: '', label: '' };
}

function findSubtitles(collected, dir, videoPath) {
  const bucket = collected.get(dir);
  if (!bucket || !bucket.subs.length) return [];
  const videoBase = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const matched = bucket.subs.filter((sub) => {
    const subBase = path.basename(sub, path.extname(sub)).toLowerCase();
    return subBase === videoBase || subBase.startsWith(videoBase + '.');
  });
  const all = collected.get(dir).videos.length === 1 ? bucket.subs : matched;
  return all.slice(0, 12).map((sub) => {
    const format = SUB_EXT.get(path.extname(sub).toLowerCase()) || 'srt';
    const lang = subtitleLanguage(sub);
    const flags = path.basename(sub, path.extname(sub)).toLowerCase();
    return {
      path: sub,
      format,
      code: lang.code,
      forced: flags.includes('forced'),
      label: (lang.label ? lang.label + ' ' : '') + '(' + format.toUpperCase() + ')',
    };
  });
}

// ---------- library building ----------

async function mapLimit(list, limit, worker) {
  const results = new Array(list.length);
  let cursor = 0;
  async function run() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, list.length); i += 1) runners.push(run());
  await Promise.all(runners);
  return results;
}

function itemFromFile({ file, dir, collected, library, info, existing }) {
  const parsed = parseMediaName(file);
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();

  const series = parsed.kind === 'episode'
    ? parsed.series || tidy(path.basename(dir).replace(/^(season|series)\s*\d+.*$/i, '')) || tidy(path.basename(path.dirname(dir)))
    : null;

  const posterPath = findArt(collected, dir, POSTER_NAMES);
  const backdropPath = findArt(collected, dir, BACKDROP_NAMES);
  const mode = playbackMode(info, ext);

  const subtitles = findSubtitles(collected, dir, file).map((sub, index) => ({
    index,
    path: sub.path,
    label: sub.label,
    code: sub.code,
    forced: sub.forced,
    format: sub.format,
  }));

  const title = parsed.kind === 'episode'
    ? (parsed.episodeTitle || 'Episode ' + parsed.episode)
    : parsed.title || path.basename(file, ext);

  return {
    id: existing || idFor(file),
    kind: parsed.kind,
    title,
    sortTitle: sortTitle(title),
    series: series || null,
    seriesSort: series ? sortTitle(series) : null,
    season: parsed.season,
    episode: parsed.episode,
    year: parsed.year,
    container: ext.replace('.', ''),
    path: file,
    libraryId: library.id,
    libraryName: library.name,
    size: stat.size,
    addedAt: stat.mtimeMs,
    duration: info && info.duration ? Math.round(info.duration) : 0,
    width: info ? info.width : 0,
    height: info ? info.height : 0,
    videoCodec: info ? info.videoCodec : null,
    audioCodec: info ? info.audioCodec : null,
    audioChannels: info ? info.audioChannels : 0,
    subtitleStreams: info ? info.subtitleStreams : 0,
    playback: mode,
    posterPath: posterPath || null,
    backdropPath: backdropPath || null,
    subtitles,
    sizeLabel: prettySize(stat.size),
  };
}

async function scanLibrary(library, options) {
  const { ffmpeg, probeCache, hiddenPaths, log, onProgress } = options;
  const collected = new Map();

  let libraryStat = null;
  try {
    libraryStat = fs.statSync(library.path);
  } catch (err) {
    log('missing: ' + library.path);
    return [];
  }

  if (libraryStat.isFile()) {
    // A single video added by hand: read its folder for artwork and subtitles,
    // but add only this one file - never its neighbours.
    const dir = path.dirname(library.path);
    const bucket = await readDirectoryInto(dir, collected);
    bucket.videos = [library.path];
  } else {
    await walkDirectory(library.path, collected, 0);
  }

  const jobs = [];
  for (const [dir, bucket] of collected) {
    for (const file of bucket.videos) {
      const name = path.basename(file).toLowerCase();
      if (/\bsample\b/.test(name)) continue;
      // Removed from the shelf by hand: stays on disk, never scanned again.
      if (hiddenPaths && hiddenPaths.has(file.toLowerCase())) continue;
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (err) {
        continue;
      }
      if (!stat.size || stat.size < 4096) continue;
      jobs.push({ file, dir, size: stat.size, mtime: stat.mtimeMs });
    }
  }

  let done = 0;
  await mapLimit(jobs, 4, async (job) => {
    const cached = probeCache[job.file];
    if (cached && cached.size === job.size && cached.mtime === job.mtime && cached.info) {
      job.info = cached.info;
    } else {
      job.info = await probe(ffmpeg, job.file);
      probeCache[job.file] = {
        size: job.size,
        mtime: job.mtime,
        info: job.info || { duration: 0, width: 0, height: 0, videoCodec: null, audioCodec: null },
      };
    }
    done += 1;
    if (onProgress) onProgress(done, jobs.length);
  });

  const items = [];
  const seen = new Set();
  for (const job of jobs) {
    let item;
    try {
      item = itemFromFile({
        file: job.file,
        dir: job.dir,
        collected,
        library,
        info: job.info,
        existing: null,
      });
    } catch (err) {
      log('skipped ' + job.file + ': ' + err.message);
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }

  log(
    'scanned "' + library.name + '": ' + items.length + ' video' + (items.length === 1 ? '' : 's')
  );
  return items;
}

module.exports = {
  scanLibrary,
  parseMediaName,
  sortTitle,
  prettySize,
  VIDEO_EXT,
  idFor,
};
