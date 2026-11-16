'use strict';

/* Casting to a TV's own Chromecast. The set gets the film as it is whenever it
   can decode it - instant, source quality, real duration, seeking. When the
   audio track is one the Cast receiver cannot decode (E-AC3, DTS, TrueHD) the
   video is copied untouched and only the audio is re-encoded to AAC, which every
   receiver plays. A full transcode is the last resort. */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { resolveFfmpeg } = require('./media');
const discovery = require('./cast-discovery');
const { connect } = require('./cast-device');

const TYPES = {
  mkv: 'video/x-matroska',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
};

// Tracks the Default Media Receiver decodes on its own.
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

function makeCastTv({ dataDir, lanBase, log = () => {} }) {
  const sessions = new Map(); // device id -> { session, itemId, device, name, duration, mode }
  const devices = { at: 0, list: [] };
  const prepared = new Map(); // item id -> path of the AAC remux
  let preparing = null;

  async function listDevices(force) {
    if (!force && Date.now() - devices.at < 20000 && devices.list.length) return devices.list;
    const found = await discovery.discover(1500);
    devices.at = Date.now();
    devices.list = found;
    return found;
  }

  function contentType(item) {
    const kind = String(item.container || '').toLowerCase();
    if (TYPES[kind]) return TYPES[kind];
    const ext = String(item.path || '').split('.').pop().toLowerCase();
    return TYPES[ext] || 'video/mp4';
  }

  function preparedPath(itemId) {
    return path.join(dataDir, 'cast-tv', String(itemId).replace(/[^a-z0-9]/gi, '') + '.mp4');
  }

  function needsAudioWork(item) {
    const codec = String(item.audioCodec || '').toLowerCase();
    if (!codec) return false; // not probed: let the TV try the original
    return !PLAYABLE_AUDIO.has(codec);
  }

  async function prepare(item) {
    const cached = preparedPath(item.id);
    if (fs.existsSync(cached)) {
      prepared.set(item.id, cached);
      return cached;
    }
    if (preparing) await preparing.catch(() => {});

    const out = cached;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const partial = out + '.part.mp4';
    try {
      fs.rmSync(partial, { force: true });
    } catch (err) {
      /* nothing to clear */
    }
    log('preparing "' + item.title + '" for the TV: copying video, converting audio');

    const run = new Promise((resolve, reject) => {
      const child = spawn(
        resolveFfmpeg(),
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', item.path,
          '-map', '0:v:0',
          '-map', '0:a:0?',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-ac', '2',
          '-movflags', '+faststart',
          '-y',
          partial,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let error = '';
      child.stderr.on('data', (chunk) => {
        error = String(chunk).trim().split('\n').slice(-2).join(' ');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('Could not prepare this video for the TV: ' + error));
      });
    });

    preparing = run;
    try {
      await run;
    } finally {
      preparing = null;
    }
    fs.renameSync(partial, out);
    prepared.set(item.id, out);
    log('ready for the TV: "' + item.title + '" with AAC audio');
    return out;
  }

  async function cast(deviceId, item) {
    const found = await listDevices(true);
    const device = found.find((entry) => entry.id === deviceId || entry.address === deviceId);
    if (!device) throw new Error('That TV is not answering on the network any more');

    const session = await connect(device);
    await session.launch();
    // Never touch the set's volume - people may be asleep in the house. Just
    // note a silent receiver so it can be fixed on the TV itself.
    let volume = null;
    try {
      const receiver = await session.status();
      volume = (receiver.status && receiver.status.volume) || null;
      if (volume && (volume.muted || Number(volume.level) === 0)) {
        log('note: the Cast volume on the TV is ' + (volume.muted ? 'muted' : '0') + ' - turn it up on the TV itself');
      }
    } catch (err) {
      /* volume is optional */
    }

    const base = lanBase();
    const image = base + '/api/art/' + encodeURIComponent(item.id);

    let url = base + '/api/stream/' + encodeURIComponent(item.id);
    let type = contentType(item);
    let mode = 'direct';

    if (needsAudioWork(item)) {
      await prepare(item);
      url = base + '/api/cast/file/' + encodeURIComponent(item.id);
      type = 'video/mp4';
      mode = 'remux';
    }

    const status = await session.load({ url, contentType: type, title: item.title, image });
    const entry = {
      session,
      itemId: item.id,
      device,
      name: device.name,
      duration: Number(item.duration) || 0,
      mode,
      // Reported so the app can warn about a silent set without touching it.
      volume,
    };

    await new Promise((resolve) => setTimeout(resolve, 3000));
    let current = status;
    try {
      current = (await session.playState()) || status;
    } catch (err) {
      current = status;
    }

    if (current.playerState === 'IDLE' || current.idleReason === 'ERROR') {
      log('the TV refused "' + item.title + '" as sent, transcoding it instead');
      const fallback = await session.load({
        url: base + '/api/play/' + encodeURIComponent(item.id) + '?force=1',
        contentType: 'video/mp4',
        title: item.title,
        image,
      });
      entry.mode = 'transcode';
      current = fallback;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    const previous = sessions.get(device.id);
    if (previous) previous.session.close();
    sessions.set(device.id, entry);
    log(
      'TV "' +
        device.name +
        '" is ' +
        (current.playerState || 'LOADING') +
        ' with "' +
        item.title +
        '" (' +
        entry.mode +
        ')'
    );
    return { device, status: current, mode: entry.mode };
  }

  function sessionFor(target) {
    for (const [id, entry] of sessions) {
      if (id === target || entry.device.address === target) return entry;
    }
    return null;
  }

  async function command(target, action, value) {
    const entry = sessionFor(target);
    if (!entry) return false;
    try {
      if (action === 'pause') await entry.session.pause();
      if (action === 'play') await entry.session.resume();
      if (action === 'seek') {
        if (entry.mode === 'transcode') return true; // a live pipe cannot skip
        await entry.session.seek(Number(value) || 0);
      }
      if (action === 'speed') return true; // no rate control over Cast
      if (action === 'stop') {
        await entry.session.stop();
        entry.session.close();
        sessions.delete(entry.device.id);
      }
      return true;
    } catch (err) {
      log('TV control failed: ' + err.message);
      sessions.delete(entry.device.id);
      return false;
    }
  }

  async function state(target) {
    const entry = sessionFor(target);
    if (!entry) return null;
    try {
      const status = await entry.session.playState();
      if (!status) return null;
      const reported = status.media ? Number(status.media.duration) || 0 : 0;
      return {
        paused: status.playerState === 'PAUSED',
        position: Number(status.currentTime) || 0,
        duration: reported || entry.duration,
        seekable: entry.mode !== 'transcode',
        volume: entry.volume || null,
        speed: 1,
        playerState: status.playerState || '',
      };
    } catch (err) {
      log('TV state failed: ' + err.message);
      return null;
    }
  }

  function preparedFile(itemId) {
    const key = String(itemId).replace(/[^a-z0-9]/gi, '');
    const known = prepared.get(key) || prepared.get(itemId);
    if (known && fs.existsSync(known)) return known;
    const guess = preparedPath(itemId);
    return fs.existsSync(guess) ? guess : null;
  }

  function stopAll() {
    for (const entry of sessions.values()) entry.session.close();
    sessions.clear();
  }

  return { listDevices, cast, command, state, preparedFile, stopAll, sessions };
}

module.exports = { makeCastTv };
