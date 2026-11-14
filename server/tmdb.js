'use strict';

// Real metadata matching against The Movie Database: identify the film or show
// from its filename, then use THAT entry's title, year, overview and artwork.
// Nothing here invents a title or a poster - every field comes back from the
// match, and the poster image is downloaded and stored next to the library.
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const API = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

// Words that end the title: everything after them is how the file was encoded.
const STOP = new Set(
  (
    '1080p 720p 2160p 480p 4k uhd hdr sdr bluray blu-ray brrip bdrip webrip web-dl webdl hdtv ' +
    'dvdrip xvid divx h264 h265 x264 x265 hevc avc aac ac3 dts dd5 1 ddp5 atmos remux proper ' +
    'repack extended unrated directors cut imax limited internal'
  ).split(/\s+/)
);

// Release-group tags that can sit in front of the real title.
const LEADING_JUNK = new Set('yify yts rarbg ntb amzn nf dsnp hmax max atvp multi subs subbed dubbed'.split(/\s+/));

const VIDEO_EXT = /\.(mp4|mkv|avi|mov|m4v|webm|wmv|flv|mpg|mpeg|ts|m2ts|ogv|3gp)$/i;

function tokenize(text) {
  return String(text || '')
    .replace(VIDEO_EXT, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(([^)]*)\)/g, (match, inner) => (/\b(19|20)\d{2}\b/.test(inner) ? ' ' + inner + ' ' : ' '))
    .replace(/[(){}]/g, ' ')
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// "Invader.Zim.Enter.the.Florpus.2019.1080p.BluRay.x264-GROUP" -> title + year
function guessFromFilename(item) {
  const raw = String(item.file || item.title || '');
  const episode = raw.match(/[Ss](\d{1,2})[\s._-]?[Ee](\d{1,3})/) || raw.match(/(\d{1,2})x(\d{2})/);
  const tokens = tokenize(raw);
  const kept = [];
  let year = null;

  for (const token of tokens) {
    if (year === null && /^(19|20)\d{2}$/.test(token)) {
      year = token;
      break;
    }
    const lower = token.toLowerCase();
    // Episode markers belong to the season/episode, not the show's name.
    if (/^s\d{1,2}(e\d{1,3})?$/i.test(lower) || /^\d{1,2}x\d{2}$/i.test(lower)) continue;
    if (/^\d{3,4}p$/.test(lower)) break;
    if (/^[a-z0-9']{1,}$/i.test(token) === false) continue;
    // "Uncut Gems" can start with a word that usually ends a name, so only
    // treat these as a stop once the title has actually started.
    if (STOP.has(lower)) {
      if (kept.length) break;
      continue;
    }
    if (LEADING_JUNK.has(lower) && !kept.length) continue;
    kept.push(token);
  }

  const title = kept.join(' ').trim();
  return {
    title,
    year: year ? Number(year) : null,
    season: episode ? Number(episode[1]) : null,
    episode: episode ? Number(episode[2]) : null,
  };
}

function apiKey(configStore) {
  const fromEnv = String(process.env.TMDB_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const fromConfig = String((configStore && configStore.read().tmdbKey) || '').trim();
  return fromConfig;
}

function getJson(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout, headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        getJson(res.headers.location, timeout).then(resolve, reject);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let message = 'The Movie Database returned HTTP ' + res.statusCode;
          try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.status_message) message += ': ' + parsed.status_message;
          } catch (err) {
            /* keep the status code */
          }
          const error = new Error(message);
          error.statusCode = res.statusCode;
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('The Movie Database sent a reply that could not be read.'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('The Movie Database did not answer in time.')));
    request.on('error', reject);
  });
}

function imageUrl(filePath, size) {
  if (!filePath) return null;
  return IMAGE_BASE + '/' + size + filePath;
}

function tidy(candidate) {
  const mediaType = candidate.media_type || (candidate.first_air_date ? 'tv' : 'movie');
  const date = candidate.release_date || candidate.first_air_date || '';
  const title = candidate.title || candidate.name || candidate.original_title || candidate.original_name || '';
  return {
    tmdbId: candidate.id,
    mediaType,
    title,
    year: date ? Number(String(date).slice(0, 4)) : null,
    overview: candidate.overview || '',
    posterUrl: imageUrl(candidate.poster_path, 'w342'),
    posterLargeUrl: imageUrl(candidate.poster_path, 'w500'),
    backdropUrl: imageUrl(candidate.backdrop_path, 'w1280'),
    vote: typeof candidate.vote_average === 'number' ? Math.round(candidate.vote_average * 10) / 10 : null,
    popularity: candidate.popularity || 0,
  };
}

// Search both movies and shows so a mis-typed type never hides the right answer.
async function search({ key, query, year, kind, language }) {
  const wantsTv = kind === 'episode' || kind === 'series' || kind === 'tv';
  const queries = [];

  if (wantsTv) {
    queries.push({ type: 'tv', url: API + '/search/tv?api_key=' + encodeURIComponent(key) + '&include_adult=false&query=' + encodeURIComponent(query) + (language ? '&language=' + language : '') });
  }
  const movieUrl = API + '/search/movie?api_key=' + encodeURIComponent(key) + '&include_adult=false&query=' + encodeURIComponent(query) + (year ? '&year=' + year : '') + (language ? '&language=' + language : '');
  queries.push({ type: 'movie', url: movieUrl });

  const results = [];
  let failure = null;
  for (const entry of queries) {
    try {
      const data = await getJson(entry.url);
      for (const candidate of (data.results || []).slice(0, 12)) {
        results.push(tidy(Object.assign({ media_type: entry.type }, candidate)));
      }
    } catch (err) {
      failure = failure || err;
    }
  }
  if (!results.length && failure) throw failure;

  const needle = query.toLowerCase();
  results.sort((a, b) => {
    const exact = (item) => (item.title.toLowerCase() === needle ? 1 : 0);
    if (exact(a) !== exact(b)) return exact(b) - exact(a);
    const yearHit = (item) => (year && item.year === Number(year) ? 1 : 0);
    if (yearHit(a) !== yearHit(b)) return yearHit(b) - yearHit(a);
    return b.popularity - a.popularity;
  });
  return results;
}

async function details({ key, tmdbId, mediaType, language }) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const url = API + '/' + type + '/' + encodeURIComponent(tmdbId) + '?api_key=' + encodeURIComponent(key) + (language ? '&language=' + language : '');
  const data = await getJson(url);
  if (type === 'tv') {
    return {
      tmdbId: data.id,
      mediaType: 'tv',
      title: data.name,
      year: data.first_air_date ? Number(String(data.first_air_date).slice(0, 4)) : null,
      overview: data.overview || '',
      genres: (data.genres || []).map((genre) => genre.name),
      runtime: Array.isArray(data.episode_run_time) && data.episode_run_time[0] ? data.episode_run_time[0] : null,
      seasons: data.number_of_seasons || null,
      posterUrl: imageUrl(data.poster_path, 'w500'),
      backdropUrl: imageUrl(data.backdrop_path, 'w1280'),
    };
  }
  return {
    tmdbId: data.id,
    mediaType: 'movie',
    title: data.title,
    year: data.release_date ? Number(String(data.release_date).slice(0, 4)) : null,
    overview: data.overview || '',
    genres: (data.genres || []).map((genre) => genre.name),
    runtime: data.runtime || null,
    seasons: null,
    posterUrl: imageUrl(data.poster_path, 'w500'),
    backdropUrl: imageUrl(data.backdrop_path, 'w1280'),
  };
}

// Save a real image from the metadata match to disk so the library keeps
// working offline and the artwork is a file the app can serve.
async function saveImage(url, dest) {
  if (!url) return null;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const temp = dest + '.part';
  await new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        saveImage(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('Poster download failed with HTTP ' + res.statusCode));
        return;
      }
      const out = fs.createWriteStream(temp);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('The poster download timed out.')));
    request.on('error', reject);
  });
  await fsp.rename(temp, dest);
  return dest;
}

module.exports = { guessFromFilename, apiKey, search, details, saveImage, imageUrl };
