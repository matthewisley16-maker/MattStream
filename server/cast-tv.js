'use strict';

/* Casting to a TV's own Chromecast: the built-in Default Media Receiver plays
   the same MP4 stream the browser player uses, so nothing is installed on the
   TV and no extra encode is run. */

const discovery = require('./cast-discovery');
const { connect } = require('./cast-device');

function makeCastTv({ lanBase, log = () => {} }) {
  const sessions = new Map(); // device id -> { session, itemId, device, name }
  const devices = { at: 0, list: [] };

  async function listDevices(force) {
    if (!force && Date.now() - devices.at < 20000 && devices.list.length) return devices.list;
    const found = await discovery.discover(1500);
    devices.at = Date.now();
    devices.list = found;
    return found;
  }

  async function cast(deviceId, item) {
    const found = await listDevices(true);
    const device = found.find((entry) => entry.id === deviceId || entry.address === deviceId);
    if (!device) throw new Error('That TV is not answering on the network any more');

    const session = await connect(device);
    await session.launch();
    const url =
      lanBase() + '/api/play/' + encodeURIComponent(item.id) + '?force=1&h=720';
    const status = await session.load({
      url,
      contentType: 'video/mp4',
      title: item.title,
      image: lanBase() + '/api/art/' + encodeURIComponent(item.id),
    });

    const previous = sessions.get(device.id);
    if (previous) previous.session.close();
    sessions.set(device.id, {
      session,
      itemId: item.id,
      device,
      name: device.name,
      // The live stream only knows the few seconds it has encoded so far.
      duration: Number(item.duration) || 0,
    });
    log('TV "' + device.name + '" is ' + (status.playerState || 'LOADING') + ' with "' + item.title + '"');
    return { device, status };
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
      if (action === 'seek') await entry.session.seek(Number(value) || 0);
      if (action === 'speed') {
        // The TV player has no speed control over Cast; say it was handled so
        // the button does not look broken.
        return true;
      }
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
      return {
        paused: status.playerState === 'PAUSED',
        position: Number(status.currentTime) || 0,
        // The film's real runtime; the live stream only reports what it has
        // encoded so far, which is a few seconds.
        duration: entry.duration || (status.media ? Number(status.media.duration) || 0 : 0),
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
