'use strict';

/* Casting to a TV's own Chromecast. The built-in Default Media Receiver gets the
   file as it is whenever the set can decode it - that plays instantly, at source
   quality, with a real duration and working seeking. Only when the set refuses
   the file does it fall back to a transcoded stream from this server. */

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

function makeCastTv({ lanBase, log = () => {} }) {
  const sessions = new Map(); // device id -> { session, itemId, device, name, duration, mode }
  const devices = { at: 0, list: [] };

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

  async function cast(deviceId, item) {
    const found = await listDevices(true);
    const device = found.find((entry) => entry.id === deviceId || entry.address === deviceId);
    if (!device) throw new Error('That TV is not answering on the network any more');

    const session = await connect(device);
    await session.launch();

    const base = lanBase();
    const image = base + '/api/art/' + encodeURIComponent(item.id);

    // Direct play: the set fetches the file itself, with byte ranges, so it
    // knows the duration and can skip anywhere.
    const status = await session.load({
      url: base + '/api/stream/' + encodeURIComponent(item.id),
      contentType: contentType(item),
      title: item.title,
      image,
    });

    const entry = {
      session,
      itemId: item.id,
      device,
      name: device.name,
      duration: Number(item.duration) || 0,
      mode: 'direct',
    };

    await new Promise((resolve) => setTimeout(resolve, 3000));
    let current = status;
    try {
      current = (await session.playState()) || status;
    } catch (err) {
      current = status;
    }

    if (current.playerState === 'IDLE' || current.idleReason === 'ERROR') {
      log('the TV cannot decode "' + item.title + '" directly, transcoding for it');
      const fallback = await session.load({
        url: base + '/api/play/' + encodeURIComponent(item.id) + '?force=1',
        contentType: 'video/mp4',
        title: item.title,
        image,
      });
      entry.mode = 'transcode';
      current = fallback;
      // Give the encoder a moment, then report the state it actually reached.
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
        if (entry.mode !== 'direct') return true; // a live transcode cannot skip
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
        duration: (entry.mode === 'direct' && reported) || entry.duration || reported,
        seekable: entry.mode === 'direct',
        speed: 1,
        playerState: status.playerState || '',
      };
    } catch (err) {
      log('TV state failed: ' + err.message);
      return null;
    }
  }

  function stopAll() {
    for (const entry of sessions.values()) entry.session.close();
    sessions.clear();
  }

  return { listDevices, cast, command, state, stopAll, sessions };
}

module.exports = { makeCastTv };
