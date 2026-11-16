'use strict';

/* MattStream - send playback to another screen: a TV, a phone, another PC.
   Every screen keeps a small event stream open to the server, so a command
   arrives instantly and the receiving screen plays the same item from the same
   server. While a cast is running the casting device keeps full controls: it
   tells the other screen what to do and reads back where the film has got to. */

const CAST_ID_KEY = 'mattstream-client-id';
const CAST_SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// Per tab, not per browser: two tabs on one machine are two screens, and a
// shared id would make each ignore the other's cast.
function castClientId() {
  try {
    let id = sessionStorage.getItem(CAST_ID_KEY);
    if (!id) {
      id = 'c-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(CAST_ID_KEY, id);
    }
    return id;
  } catch (err) {
    return 'c-' + Math.random().toString(36).slice(2, 10);
  }
}

function castDeviceName() {
  const forced = new URLSearchParams(location.search).get('name');
  if (forced) return forced.slice(0, 40);
  const ua = navigator.userAgent || '';
  if (/Android TV|Google TV|Fire TV|AFT[0-9A-Z]/i.test(ua)) return 'Android TV';
  if (/Android/i.test(ua)) return 'Phone';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Macintosh|Mac OS/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'This screen';
}

let castStream = null;
let castBanner = null;

function startCastChannel() {
  if (castStream || typeof EventSource === 'undefined') return;
  const url =
    '/api/cast/events?client=' +
    encodeURIComponent(castClientId()) +
    '&name=' +
    encodeURIComponent(castDeviceName());
  castStream = new EventSource(url);
  castStream.onmessage = (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (!payload) return;
    if (payload.type === 'cast') receiveCast(payload);
    if (payload.type === 'command') handleCastCommand(payload);
  };
}

/* ---------- this screen is the one playing ---------- */

function receiveCast(payload) {
  if (payload.from && payload.from === castClientId()) return;
  const item = (state.items || []).find((entry) => entry.id === payload.itemId);
  if (!item) return;
  showCastBanner(payload.fromName || 'another device', item);
  if (typeof openPlayer === 'function') openPlayer(item);
  startCastReporting(item.id);
}

function showCastBanner(fromName, item) {
  if (castBanner) castBanner.remove();
  castBanner = el('div', 'cast-banner');
  castBanner.appendChild(el('span', 'cast-banner-text', 'Casting "' + item.title + '" from ' + fromName));
  const stop = el('button', 'btn is-ghost', 'Stop');
  stop.type = 'button';
  stop.addEventListener('click', () => {
    if (castBanner) castBanner.remove();
    castBanner = null;
    stopCastReporting();
    if (typeof closePlayer === 'function') closePlayer();
  });
  castBanner.appendChild(stop);
  document.body.appendChild(castBanner);
}

let castReportTimer = null;

function startCastReporting(itemId) {
  stopCastReporting();
  castReportTimer = setInterval(() => {
    const video = typeof player !== 'undefined' ? player.video : null;
    if (!video) return;
    const offset = typeof player.offset === 'number' ? player.offset : 0;
    fetch('/api/cast/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: castClientId(),
        itemId,
        paused: video.paused,
        position: Math.max(0, offset + (video.currentTime || 0)),
        duration: player.duration || 0,
        speed: video.playbackRate || 1,
      }),
    }).catch(() => {});
  }, 2000);
}

function stopCastReporting() {
  if (castReportTimer) clearInterval(castReportTimer);
  castReportTimer = null;
}

function handleCastCommand(command) {
  const video = typeof player !== 'undefined' ? player.video : null;
  if (!video) return;
  if (command.action === 'pause') video.pause();
  if (command.action === 'play') video.play().catch(() => {});
  if (command.action === 'seek' && Number.isFinite(command.value) && typeof seekTo === 'function') {
    seekTo(command.value);
  }
  if (command.action === 'speed' && command.value) video.playbackRate = command.value;
  if (command.action === 'stop') {
    stopCastReporting();
    if (castBanner) castBanner.remove();
    castBanner = null;
    if (typeof closePlayer === 'function') closePlayer();
  }
}

/* ---------- this screen is driving the cast ---------- */

let castRemote = null;
let castRemoteTimer = null;
let castRemoteTarget = null;
let castRemoteItem = null;
let castRemoteDragging = false;
let castRemoteState = { paused: false, position: 0, duration: 0, speed: 1 };

async function sendCastCommand(action, value) {
  if (!castRemoteTarget) return false;
  try {
    const res = await fetch('/api/cast/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: castRemoteTarget.id, action, value }),
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}

function closeCastRemote() {
  if (castRemoteTimer) clearInterval(castRemoteTimer);
  castRemoteTimer = null;
  if (castRemote) castRemote.remove();
  castRemote = null;
  castRemoteTarget = null;
  castRemoteItem = null;
  castRemoteDragging = false;
}

function renderCastRemote() {
  if (!castRemote) return;
  const seek = castRemote.querySelector('.cast-remote-seek');
  const time = castRemote.querySelector('.cast-remote-time');
  const play = castRemote.querySelector('.cast-remote-play');
  const speed = castRemote.querySelector('.cast-remote-speed');
  const duration = castRemoteState.duration || 0;
  if (time) time.textContent = formatClock(castRemoteState.position) + ' / ' + formatClock(duration);
  if (seek && !castRemoteDragging) {
    seek.value = duration ? String(Math.round((castRemoteState.position / duration) * 1000)) : '0';
  }
  if (play) play.textContent = castRemoteState.paused ? 'Play' : 'Pause';
  if (speed) {
    speed.textContent = (castRemoteState.speed || 1) + '×';
    // The Cast protocol has no playback rate for the default player.
    speed.style.display = castRemoteTv ? 'none' : '';
  }
  // A transcode cannot be skipped through, so do not offer what would not work.
  const sound = castRemoteState.volume;
  const silent = sound && (sound.muted || Number(sound.level) < 0.1);
  const volumeNote = castRemote.querySelector('.cast-remote-warn');
  if (volumeNote) {
    volumeNote.textContent = silent
      ? 'The TV volume is ' + Math.round((Number(sound.level) || 0) * 100) + '%' + (sound.muted ? ' and muted' : '') + ' - turn it up on the TV'
      : '';
    volumeNote.style.display = silent ? '' : 'none';
  }
  const canSeek = !castRemoteTv || castRemoteState.seekable !== false;
  if (seek) seek.style.display = canSeek ? '' : 'none';
  const back = castRemote.querySelector('.cast-remote-back');
  const fwd = castRemote.querySelector('.cast-remote-fwd');
  if (back) back.style.display = canSeek ? '' : 'none';
  if (fwd) fwd.style.display = canSeek ? '' : 'none';
}

async function refreshCastRemote() {
  if (!castRemoteTarget) return;
  try {
    const res = await fetch('/api/cast/state?target=' + encodeURIComponent(castRemoteTarget.id), {
      cache: 'no-store',
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.connected) {
      const eyebrow = castRemote && castRemote.querySelector('.cast-remote-eyebrow');
      if (eyebrow) eyebrow.textContent = 'The screen disconnected';
      return;
    }
    if (!data.session) return;
    castRemoteState = {
      paused: Boolean(data.session.paused),
      position: Number(data.session.position) || 0,
      duration: Number(data.session.duration) || 0,
      speed: Number(data.session.speed) || 1,
      seekable: data.session.seekable,
      volume: data.session.volume || null,
    };
    renderCastRemote();
  } catch (err) {
    /* keep the last known state */
  }
}

let castRemoteTv = false;

function showCastRemote(target, item, options) {
  const tv = Boolean(options && options.tv);
  castRemoteTv = tv;
  closeCastRemote();
  // The point of casting is that the other screen plays it, so stop here.
  if (typeof player !== 'undefined' && player.item && typeof closePlayer === 'function') closePlayer();

  castRemoteTarget = target;
  castRemoteItem = item;
  castRemoteState = { paused: false, position: 0, duration: Number(item.duration) || 0, speed: 1 };

  const panel = el('div', 'cast-remote');
  const art = el('div', 'cast-remote-art');
  art.style.backgroundImage = 'url("/api/art/' + encodeURIComponent(item.id) + '")';
  panel.appendChild(art);

  const body = el('div', 'cast-remote-body');
  body.appendChild(el('span', 'cast-remote-eyebrow', 'Playing on ' + target.name));
  body.appendChild(el('h2', null, item.title));

  // A TV plays a live transcode; its player cannot jump around in it, so the
  // seek bar and the skip buttons would be dead weight there.
  const seek = document.createElement('input');
  seek.type = 'range';
  seek.className = 'cast-remote-seek';
  seek.min = '0';
  seek.max = '1000';
  seek.value = '0';
  seek.setAttribute('aria-label', 'Seek on the other screen');
  seek.addEventListener('input', () => {
    castRemoteDragging = true;
    const duration = castRemoteState.duration || 0;
    const time = castRemote.querySelector('.cast-remote-time');
    if (time) {
      time.textContent =
        formatClock((Number(seek.value) / 1000) * duration) + ' / ' + formatClock(duration);
    }
  });
  seek.addEventListener('change', async () => {
    const duration = castRemoteState.duration || 0;
    const position = (Number(seek.value) / 1000) * duration;
    castRemoteDragging = false;
    castRemoteState.position = position;
    renderCastRemote();
    await sendCastCommand('seek', position);
  });
  body.appendChild(seek);
  body.appendChild(el('div', 'cast-remote-time', '0:00 / ' + formatClock(castRemoteState.duration)));
  const warn = el('p', 'hint cast-warn cast-remote-warn', '');
  warn.style.display = 'none';
  body.appendChild(warn);

  const buttons = el('div', 'cast-remote-buttons');

  const back = el('button', 'btn is-ghost cast-remote-back', '-10s');
  back.type = 'button';
  back.addEventListener('click', async () => {
    const goal = Math.max(0, castRemoteState.position - 10);
    castRemoteState.position = goal;
    renderCastRemote();
    await sendCastCommand('seek', goal);
  });
  buttons.appendChild(back);

  const play = el('button', 'btn is-primary cast-remote-play', 'Pause');
  play.type = 'button';
  play.addEventListener('click', async () => {
    const wantPause = !castRemoteState.paused;
    castRemoteState.paused = wantPause;
    renderCastRemote();
    await sendCastCommand(wantPause ? 'pause' : 'play');
  });
  buttons.appendChild(play);

  const fwd = el('button', 'btn is-ghost cast-remote-fwd', '+10s');
  fwd.type = 'button';
  fwd.addEventListener('click', async () => {
    const goal = castRemoteState.position + 10;
    castRemoteState.position = goal;
    renderCastRemote();
    await sendCastCommand('seek', goal);
  });
  buttons.appendChild(fwd);

  const speed = el('button', 'btn is-ghost cast-remote-speed', '1×');
  speed.type = 'button';
  speed.title = 'Playback speed on the other screen';
  speed.addEventListener('click', async () => {
    const at = CAST_SPEEDS.indexOf(castRemoteState.speed || 1);
    const next = CAST_SPEEDS[(at + 1) % CAST_SPEEDS.length];
    castRemoteState.speed = next;
    renderCastRemote();
    await sendCastCommand('speed', next);
    toast('Speed ' + next + '× on ' + castRemoteTarget.name);
  });
  buttons.appendChild(speed);

  const stop = el('button', 'btn is-ghost', 'Stop casting');
  stop.type = 'button';
  stop.addEventListener('click', async () => {
    await sendCastCommand('stop');
    closeCastRemote();
  });
  buttons.appendChild(stop);

  body.appendChild(buttons);
  panel.appendChild(body);
  document.body.appendChild(panel);
  castRemote = panel;
  renderCastRemote();
  refreshCastRemote();
  castRemoteTimer = setInterval(refreshCastRemote, 1500);
}

/* ---------- picking a screen ---------- */

async function castTargets() {
  try {
    const res = await fetch('/api/cast/targets?client=' + encodeURIComponent(castClientId()), {
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.targets || [];
  } catch (err) {
    return [];
  }
}

let castNetwork = null;

async function castAddress() {
  try {
    const res = await fetch('/api/network', { cache: 'no-store' });
    if (!res.ok) return '';
    const data = await res.json();
    castNetwork = data;
    if (data.tunnel) return data.tunnel;
    if (data.lan && data.lan.length) return data.lan[0];
  } catch (err) {
    /* fall back to whatever address this page is on */
  }
  return location.origin;
}

async function castTvDevices() {
  try {
    const res = await fetch('/api/cast/devices', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return data.devices || [];
  } catch (err) {
    return [];
  }
}

async function openCastMenu(item) {
  const targets = await castTargets();
  const tvs = await castTvDevices();
  const address = await castAddress();
  const dialog = dialogShell(true);
  const body = el('div', 'dialog-body');
  body.appendChild(el('h2', null, 'Cast to a screen'));
  body.appendChild(
    el(
      'p',
      'hint',
      'Any screen here streams this video from this server - no copy is made, and the controls keep ' +
        'working on it. TVs on the network play through their own Chromecast, so they need nothing installed.'
    )
  );

  if (!targets.length && !tvs.length) {
    body.appendChild(
      el(
        'div',
        'browser-empty',
        'No screens answered. A TV with the MattStream app must have it open and pointed at the address ' +
          'below; a Chromecast TV must be switched on and on the same network. If nothing works, check that ' +
          'Windows Firewall allows MattStream on TCP port 8096.'
      )
    );
  } else {
    const seen = {};
    for (const target of targets) seen[target.name] = (seen[target.name] || 0) + 1;

    const list = el('div', 'cast-list');
    for (const target of targets) {
      const row = el('div', 'cast-row');
      const info = el('div', 'cast-info');
      const label = seen[target.name] > 1 ? target.name + ' #' + String(target.id).slice(-4) : target.name;
      info.appendChild(el('strong', null, label));
      info.appendChild(el('span', 'hint', 'Connected'));
      row.appendChild(info);

      const play = el('button', 'btn is-primary', 'Play there');
      play.type = 'button';
      play.addEventListener('click', async () => {
        play.disabled = true;
        try {
          const res = await fetch('/api/cast', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              client: target.id,
              itemId: item.id,
              from: castClientId(),
              fromName: castDeviceName(),
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not cast');
          closeDialog();
          toast('Playing on ' + (data.target || target.name));
          showCastRemote(target, item);
        } catch (err) {
          toast(err.message, true);
          play.disabled = false;
        }
      });
      row.appendChild(play);
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  if (tvs.length) {
    body.appendChild(el('h3', 'cast-section', 'TVs on your network'));
    const tvList = el('div', 'cast-list');
    for (const tv of tvs) {
      const row = el('div', 'cast-row');
      const info = el('div', 'cast-info');
      info.appendChild(el('strong', null, tv.name));
      info.appendChild(el('span', 'hint', tv.model + ' - no app needed'));
      row.appendChild(info);

      const play = el('button', 'btn is-primary', 'Play on TV');
      play.type = 'button';
      play.addEventListener('click', async () => {
        play.disabled = true;
        play.textContent = 'Starting...';
        try {
          const res = await fetch('/api/cast/tv', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId: tv.id, itemId: item.id }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not cast to that TV');
          closeDialog();
          toast('Playing on ' + (data.target || tv.name));
          showCastRemote({ id: tv.id, name: tv.name }, item, { tv: true });
        } catch (err) {
          toast(err.message, true);
          play.disabled = false;
          play.textContent = 'Play on TV';
        }
      });
      row.appendChild(play);
      tvList.appendChild(row);
    }
    body.appendChild(tvList);
  }

  if (castNetwork && castNetwork.firewall === false) {
    body.appendChild(
      el(
        'p',
        'hint cast-warn',
        'Windows Firewall does not allow MattStream on port 8096, so no device can reach this server. ' +
          'Allow it in Windows Security > Firewall & network protection > Allow an app through firewall.'
      )
    );
  }

  if (address) {
    const line = el('div', 'cast-address-row');
    line.appendChild(el('span', 'hint', 'TV app: open this address on the TV once -'));
    const code = el('code', 'cast-address', address);
    line.appendChild(code);
    const copy = el('button', 'btn is-ghost', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      if (navigator.clipboard) navigator.clipboard.writeText(address).then(() => toast('Address copied'), () => {});
    });
    line.appendChild(copy);
    body.appendChild(line);
  }

  const actions = el('div', 'dialog-actions');
  const refresh = el('button', 'btn is-ghost', 'Refresh');
  refresh.type = 'button';
  refresh.addEventListener('click', () => {
    closeDialog();
    openCastMenu(item);
  });
  actions.appendChild(refresh);
  const close = el('button', 'btn is-ghost', 'Close');
  close.type = 'button';
  close.addEventListener('click', closeDialog);
  actions.appendChild(close);
  body.appendChild(actions);

  dialog.appendChild(body);
  openDialog(dialog);
}

window.openCastMenu = openCastMenu;
window.closeCastRemote = closeCastRemote;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startCastChannel);
} else {
  startCastChannel();
}
