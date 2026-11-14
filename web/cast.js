'use strict';

/* MattStream - send playback to another screen: a TV, a phone, another PC.
   Every screen keeps a small event stream open to the server, so a command
   arrives instantly and the receiving screen plays the same item from the
   same server. Nothing is copied between devices. */

const CAST_ID_KEY = 'mattstream-client-id';

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
    if (payload && payload.type === 'cast') receiveCast(payload);
  };
}

function receiveCast(payload) {
  if (payload.from && payload.from === castClientId()) return;
  const item = (state.items || []).find((entry) => entry.id === payload.itemId);
  if (!item) return;
  showCastBanner(payload.fromName || 'another device', item);
  if (typeof openPlayer === 'function') openPlayer(item);
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
    if (typeof closePlayer === 'function') closePlayer();
  });
  castBanner.appendChild(stop);
  document.body.appendChild(castBanner);
}

async function castTargets() {
  try {
    const res = await fetch('/api/cast/targets?client=' + encodeURIComponent(castClientId()), { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return data.targets || [];
  } catch (err) {
    return [];
  }
}

async function openCastMenu(item) {
  const targets = await castTargets();
  const dialog = dialogShell(true);
  const body = el('div', 'dialog-body');
  body.appendChild(el('h2', null, 'Cast to a screen'));
  body.appendChild(
    el(
      'p',
      'hint',
      'The other screen opens the player and streams this video from this server - no copy is made. ' +
        'Open MattStream on your TV, phone or another PC and it appears here.'
    )
  );

  if (!targets.length) {
    body.appendChild(
      el(
        'div',
        'browser-empty',
        'No other screens are connected right now. Start MattStream on the TV (the Android TV app, or its ' +
          'browser) and press Refresh.'
      )
    );
  } else {
    // Two screens on one PC (the app window and a browser tab) should be told
    // apart, otherwise they look like the same target twice.
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
          toast('Playing on ' + (data.target || target.name));
          closeDialog();
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startCastChannel);
} else {
  startCastChannel();
}
