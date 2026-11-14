'use strict';

// FFmpeg discovery, probing, and the playback decision for each file.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let cachedFfmpeg = null;

function resolveFfmpeg(appRoot) {
  if (cachedFfmpeg) return cachedFfmpeg;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(appRoot, 'bin', exe),
    path.join(appRoot, 'node_modules', 'ffmpeg-static', exe),
    exe,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === exe) {
      cachedFfmpeg = candidate;
      break;
    }
    try {
      if (fs.statSync(candidate).isFile()) {
        cachedFfmpeg = candidate;
        break;
      }
    } catch (err) {
      // keep looking
    }
  }
  if (!cachedFfmpeg) cachedFfmpeg = exe;
  return cachedFfmpeg;
}

function ffmpegWorks(ffmpegPath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-version'], { windowsHide: true });
    } catch (err) {
      return done(false);
    }
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    setTimeout(() => {
      try { child.kill(); } catch (e) {}
      done(false);
    }, 10000);
  });
}

// ffmpeg -i <file> exits with code 1 but prints all the stream details to stderr.
function parseProbe(text) {
  const info = {
    duration: 0,
    width: 0,
    height: 0,
    videoCodec: null,
    audioCodec: null,
    audioChannels: 0,
    audioStreams: 0,
    subtitleStreams: 0,
  };

  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(text);
  if (duration) {
    info.duration =
      Number(duration[1]) * 3600 +
      Number(duration[2]) * 60 +
      Number(duration[3]) +
      Number('0.' + duration[4]);
  }

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!info.videoCodec) {
      const video = /Stream #\d+:\d+[^:]*: Video: ([A-Za-z0-9_]+)/.exec(line);
      if (video) {
        info.videoCodec = video[1].toLowerCase();
        const size = /(\d{2,5})x(\d{2,5})/.exec(line);
        if (size) {
          info.width = Number(size[1]);
          info.height = Number(size[2]);
        }
      }
    }
    const audio = /Stream #\d+:\d+[^:]*: Audio: ([A-Za-z0-9_]+)/.exec(line);
    if (audio) {
      info.audioStreams += 1;
      if (!info.audioCodec) {
        info.audioCodec = audio[1].toLowerCase();
        if (/\bstereo\b/.test(line)) info.audioChannels = 2;
        else if (/\bmono\b/.test(line)) info.audioChannels = 1;
        else {
          const channels = /(\d+) channels/.exec(line);
          info.audioChannels = channels ? Number(channels[1]) : 2;
        }
      }
    }
    if (/Stream #\d+:\d+[^:]*: Subtitle:/.test(line)) info.subtitleStreams += 1;
  }
  return info;
}

function probe(ffmpegPath, file) {
  return new Promise((resolve) => {
    let settled = false;
    let text = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    } catch (err) {
      return finish(null);
    }
    child.stderr.on('data', (chunk) => {
      if (text.length < 400000) text += chunk.toString('utf8');
    });
    child.stdout.on('data', () => {});
    child.on('error', () => finish(null));
    child.on('close', () => finish(parseProbe(text)));
    setTimeout(() => {
      try { child.kill(); } catch (e) {}
      finish(null);
    }, 20000);
  });
}

const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis']);
const DIRECT_CONTAINERS = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mov']);

// Decide how a file reaches the browser:
//   direct    - the browser can play the file as-is (with byte ranges, full seeking)
//   remux     - copy the video, repackage into fragmented MP4 (fast, cheap)
//   transcode - re-encode video and/or audio (works for literally any format)
function playbackMode(info, ext) {
  const container = String(ext || '').toLowerCase();
  const video = info && info.videoCodec ? info.videoCodec : null;
  const audio = info && info.audioCodec ? info.audioCodec : null;
  const audioOk = !audio || DIRECT_AUDIO.has(audio);

  if (DIRECT_CONTAINERS.has(container) && (!video || DIRECT_VIDEO.has(video)) && audioOk) {
    return 'direct';
  }
  if (video === 'h264') return 'remux';
  return 'transcode';
}

function copyVideoStream(info) {
  return Boolean(info && info.videoCodec === 'h264');
}

function copyAudioStream(info) {
  if (!info || !info.audioCodec) return true;
  return info.audioCodec === 'aac' || info.audioCodec === 'mp3';
}

// Fragmented MP4 flags keep the stream playable while it is still being written.
const FRAGMENTED = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4'];

function buildPlayArgs(input, offsetSec, info, forceTranscode) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const offset = Math.max(0, Math.floor(Number(offsetSec) || 0));
  // Input seeking before -i is fast and keyframe aligned.
  if (offset > 0) args.push('-ss', String(offset));
  args.push('-i', input);

  if (info && info.subtitleStreams) args.push('-sn');
  args.push('-map', '0:v:0', '-map', '0:a:0?');

  const videoCopy = !forceTranscode && copyVideoStream(info);
  if (videoCopy) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level', '4.1',
      '-maxrate', '8M',
      '-bufsize', '16M'
    );
    // Only downscale when the source is bigger than 1080p; never upscale.
    if (info && Number(info.width) > 1920) args.push('-vf', 'scale=1920:-2');
  }

  if (!forceTranscode && copyAudioStream(info)) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }

  args.push('-max_muxing_queue_size', '2048');
  if (videoCopy) args.push('-avoid_negative_ts', 'make_zero');
  args.push(...FRAGMENTED, 'pipe:1');
  return args;
}

module.exports = {
  resolveFfmpeg,
  ffmpegWorks,
  parseProbe,
  probe,
  playbackMode,
  buildPlayArgs,
};
