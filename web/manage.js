// MattStream: server connections and media management.
//
// The app itself is always served by a MattStream server, so "connecting" means
// pointing this window (or the Android app) at the right one. Everything here
// talks to that server and shows what it really reports.

const SERVERS_KEY = 'mattstream-servers';
const ACTIVE_KEY = 'mattstream-active-server';

/* ---------------- saved servers ---------------- */

function readServers() {
  try {
    const list = JSON.parse(localStorage.getItem(SERVERS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function writeServers(list) {
  localStorage.setItem(SERVERS_KEY, JSON.stringify(list));
}

function activeServerId() {
  return localStorage.getItem(ACTIVE_KEY) || '';
}

function setActiveServer(id) {
  localStorage.setItem(ACTIVE_KEY, id);
}

function serverById(id) {
  return readServers().find((server) => server.id === id) || null;
}

// app.js sends this header with every API call once a key is known.
window.mattstreamServerKey = function () {
  const server = serverById(activeServerId());
  return server && server.key ? server.key : '';
};

function normalizeUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
  value = value.replace(/\/+$/, '');
  const afterScheme = value.slice(value.indexOf('//') + 2);
  if (!afterScheme.includes(':') && !afterScheme.includes('/')) value += ':8096';
  return value;
}

async function testServer(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { online: false, error: 'No address' };
  try {
    const res = await fetch(url + '/api/status', { cache: 'no-store' });
    if (!res.ok) return { online: false, error: 'HTTP ' + res.status };
    const data = await res.json();
    if (!data || !data.version) return { online: false, error: 'Not a MattStream server' };
    return { online: true, status: data, url };
  } catch (err) {
    return { online: false, error: err.message || 'Unreachable', url };
  }
}

// One entry for the server this page came from, so it can be switched back to.
function registerCurrentServer(name) {
  const url = location.origin;
  const list = readServers();
  let server = list.find((entry) => normalizeUrl(entry.url) === url);
  if (!server) {
    server = {
      id: 'srv-' + Date.now().toString(36),
      name: name || location.hostname,
      url,
      key: '',
      added: Date.now(),
    };
    list.push(server);
    writeServers(list);
  } else if (name) {
    server.name = name;
    writeServers(list);
  }
  if (!activeServerId()) setActiveServer(server.id);
  return server;
}

function goToServer(server) {
  setActiveServer(server.id);
  const target = normalizeUrl(server.url) + '/';
  if (target === location.origin + '/') return false;
  location.href = target;
  return true;
}

/* ---------------- server connection page ---------------- */

function openServersDialog(focusKey) {
  const dialog = dialogShell(true);
  const body = el('div', 'dialog-body');

  body.appendChild(el('h2', null, 'Server connection'));
  body.appendChild(
    el(
      'p',
      'hint',
      'MattStream runs on the computer that hosts your media. Point this device at that address - a LAN address ' +
        'like http://192.168.1.24:8096, not localhost - and the library, artwork and playback all come from it. ' +
        'Each person keeps their own servers; nothing is merged.'
    )
  );

  const currentCard = el('div', 'server-current');
  const currentName = el('strong', null, (state.status && state.status.serverName) || location.hostname);
  const currentUrl = el('span', 'mono', location.origin);
  const dot = el('i', 'dot is-online');
  const currentLine = el('div', 'server-line');
  currentLine.appendChild(dot);
  currentLine.appendChild(currentName);
  currentLine.appendChild(currentUrl);
  currentCard.appendChild(currentLine);
  currentCard.appendChild(
    el('span', 'hint', adminState.admin ? 'You are an administrator on this server.' : 'Signed in as a viewer on this server.')
  );
  if (adminState.admin && adminState.key) {
    const keyRow = el('div', 'server-key');
    keyRow.appendChild(el('span', 'hint', 'Admin key (use it on your phone or TV):'));
    const keyValue = el('code', 'mono', adminState.key);
    keyRow.appendChild(keyValue);
    const copy = el('button', 'icon-btn', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(adminState.key);
        toast('Admin key copied');
      } catch (err) {
        toast('Copy failed - select the key by hand', true);
      }
    });
    keyRow.appendChild(copy);
    currentCard.appendChild(keyRow);
  }
  body.appendChild(currentCard);

  const listWrap = el('div', 'lib-list');
  const servers = readServers();
  const activeId = activeServerId();
  if (!servers.length) listWrap.appendChild(el('div', 'browser-empty', 'No servers saved yet.'));

  for (const server of servers) {
    const row = el('div', 'lib-row');
    const info = el('div', 'lib-info');
    info.appendChild(el('strong', null, server.name || server.url));
    info.appendChild(el('span', null, server.url));
    row.appendChild(info);

    const status = el('span', 'lib-count', 'checking...');
    row.appendChild(status);

    const testButton = el('button', 'icon-btn', 'Test');
    testButton.type = 'button';
    testButton.addEventListener('click', async () => {
      status.textContent = 'checking...';
      status.classList.remove('is-online', 'is-offline');
      const result = await testServer(server.url);
      status.textContent = result.online ? 'online' : 'offline';
      status.classList.add(result.online ? 'is-online' : 'is-offline');
      if (result.online) dot.className = 'dot is-online';
    });
    row.appendChild(testButton);

    const connect = el('button', 'btn is-primary', server.id === activeId ? 'Current' : 'Connect');
    connect.type = 'button';
    if (server.id === activeId) connect.disabled = true;
    connect.addEventListener('click', () => {
      if (!goToServer(server)) {
        toast('Already on ' + server.name);
        closeDialog();
      }
    });
    row.appendChild(connect);

    const isDefault = server.id === defaultServerId();
    if (isDefault) {
      row.classList.add('is-default');
      info.appendChild(el('span', 'lib-default', 'Default library'));
    } else {
      const makeDefault = el('button', 'icon-btn', 'Set as default');
      makeDefault.type = 'button';
      makeDefault.addEventListener('click', () => {
        setDefaultServerId(server.id);
        toast(server.name + ' is now your default library');
        closeDialog();
        openServersDialog();
        refreshChip();
      });
      row.appendChild(makeDefault);
    }

    const edit = el('button', 'icon-btn', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => openServerForm(server));
    row.appendChild(edit);

    const remove = twoStepButton('Remove', 'Remove?', async () => {
      writeServers(readServers().filter((entry) => entry.id !== server.id));
      if (activeServerId() === server.id) localStorage.removeItem(ACTIVE_KEY);
      closeDialog();
      openServersDialog();
      toast('Removed ' + server.name);
    });
    row.appendChild(remove);

    listWrap.appendChild(row);

    // Show the truth about each server without being asked, too.
    testServer(server.url).then((result) => {
      status.textContent = result.online ? 'online' : 'offline';
      status.classList.add(result.online ? 'is-online' : 'is-offline');
    });
  }
  body.appendChild(listWrap);

  body.appendChild(el('h3', null, 'Add a server'));
  body.appendChild(openServerForm(null, body, focusKey));
  dialog.appendChild(body);
  openDialog(dialog);
}

function openServerForm(existing, mount, focusKey) {
  const wrap = el('div', 'server-form');
  const nameInput = document.createElement('input');
  nameInput.className = 'control';
  nameInput.placeholder = 'Living room PC';
  nameInput.value = existing ? existing.name || '' : '';
  nameInput.setAttribute('aria-label', 'Server name');

  const urlInput = document.createElement('input');
  urlInput.className = 'control mono';
  urlInput.placeholder = 'http://192.168.1.24:8096';
  urlInput.value = existing ? existing.url : location.origin;
  urlInput.setAttribute('aria-label', 'Server address');

  const keyInput = document.createElement('input');
  keyInput.className = 'control mono';
  keyInput.placeholder = 'Admin key (optional, for adding or deleting)';
  keyInput.value = existing ? existing.key || '' : '';
  keyInput.setAttribute('aria-label', 'Admin key');

  const fields = el('div', 'server-fields');
  const field = (label, input) => {
    const holder = el('label', 'field');
    holder.appendChild(el('span', null, label));
    holder.appendChild(input);
    return holder;
  };
  fields.appendChild(field('Name', nameInput));
  fields.appendChild(field('Address', urlInput));
  fields.appendChild(field('Admin key', keyInput));
  wrap.appendChild(fields);

  const row = el('div', 'browser-actions');
  const testResult = el('span', 'hint', '');
  const test = el('button', 'btn is-ghost', 'Test connection');
  test.type = 'button';
  test.addEventListener('click', async () => {
    test.disabled = true;
    testResult.textContent = 'Testing ' + normalizeUrl(urlInput.value) + ' ...';
    const result = await testServer(urlInput.value);
    test.disabled = false;
    testResult.textContent = result.online
      ? 'Online - MattStream v' + result.status.version + (result.status.serverName ? ' on ' + result.status.serverName : '')
      : 'Offline - ' + result.error;
    testResult.classList.toggle('is-error', !result.online);
    if (result.online && !nameInput.value.trim() && result.status.serverName) {
      nameInput.value = result.status.serverName;
    }
  });
  row.appendChild(test);

  const save = el('button', 'btn is-primary', existing ? 'Save changes' : 'Save and connect');
  save.type = 'button';
  save.addEventListener('click', async () => {
    const url = normalizeUrl(urlInput.value);
    if (!url) {
      toast('Enter the server address', true);
      return;
    }
    const list = readServers();
    const server = {
      id: existing ? existing.id : 'srv-' + Date.now().toString(36),
      name: nameInput.value.trim() || url,
      url,
      key: keyInput.value.trim(),
      added: existing ? existing.added || Date.now() : Date.now(),
    };
    const index = list.findIndex((entry) => entry.id === server.id);
    if (index >= 0) list[index] = server;
    else list.push(server);
    writeServers(list);

    save.disabled = true;
    const result = await testServer(url);
    save.disabled = false;
    if (!result.online) {
      toast('Saved, but ' + url + ' is offline: ' + result.error, true);
      return;
    }
    if (!goToServer(server)) {
      toast('Connected to ' + server.name);
      loadAdmin().then(() => {
        closeDialog();
        refreshLibrary();
      });
    }
  });
  row.appendChild(save);

  if (existing) {
    const cancel = el('button', 'btn is-ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => openServersDialog());
    row.appendChild(cancel);
  }

  wrap.appendChild(row);
  wrap.appendChild(testResult);

  if (focusKey) setTimeout(() => keyInput.focus(), 60);
  if (mount) return wrap;
  openDialog(wrap);
  return wrap;
}

/* ---------------- admin state ---------------- */

const adminState = { known: false, admin: false, key: '', serverName: '' };

async function loadAdmin() {
  try {
    const data = await api('/api/admin');
    adminState.known = true;
    adminState.admin = Boolean(data.admin);
    adminState.key = data.key || '';
    adminState.serverName = data.serverName || '';
  } catch (err) {
    adminState.known = true;
    adminState.admin = false;
  }
  return adminState;
}

function adminOnly(node) {
  return adminState.admin ? node : null;
}

function requireAdminMessage() {
  const card = el('div', 'manage-locked');
  card.appendChild(el('h3', null, 'Administrator access needed'));
  card.appendChild(
    el(
      'p',
      'hint',
      'Adding, editing and permanently deleting files is limited to the server owner. On the computer running ' +
        'MattStream you already are the owner. On a phone or TV, enter the admin key from the Server connection page.'
    )
  );
  const button = el('button', 'btn is-primary', 'Open server connection');
  button.type = 'button';
  button.addEventListener('click', () => openServersDialog(true));
  card.appendChild(button);
  return card;
}

/* ---------------- media management page ---------------- */

function metadataIssues(item) {
  const issues = [];
  // An episode's artwork is its still, not a poster.
  if (item.kind === 'episode') {
    if (!item.thumbPath && !item.posterPath) issues.push('no thumbnail');
  } else if (!item.posterPath) {
    issues.push('no poster');
  }
  if (!item.year) issues.push('no year');
  if (!item.overview) issues.push('no description');
  return issues;
}

function viewManage() {
  const wrap = el('div', 'manage');
  const head = el('div', 'section-head');
  head.appendChild(el('h1', null, 'Media management'));
  head.appendChild(el('span', 'count', state.items.length + ' item' + (state.items.length === 1 ? '' : 's')));
  head.appendChild(el('div', 'spacer'));
  const servers = el('button', 'btn is-ghost', 'Server connection');
  servers.type = 'button';
  servers.addEventListener('click', () => openServersDialog());
  head.appendChild(servers);
  wrap.appendChild(head);

  if (!adminState.known) {
    loadAdmin().then(() => render());
    wrap.appendChild(el('p', 'hint', 'Checking administrator access...'));
    return wrap;
  }

  if (!adminState.admin) {
    wrap.appendChild(requireAdminMessage());
    return wrap;
  }

  const table = el('div', 'manage-table');
  const headerRow = el('div', 'manage-row is-head');
  for (const label of ['', 'Title', 'File', 'Type', 'Size', 'Metadata', 'Actions']) {
    headerRow.appendChild(el('span', null, label));
  }
  table.appendChild(headerRow);

  const items = [...state.items].sort((a, b) => String(a.sortTitle || a.title).localeCompare(String(b.sortTitle || b.title)));
  if (!items.length) {
    table.appendChild(el('div', 'browser-empty', 'Nothing in the library yet - add a folder or upload a video first.'));
  }

  for (const item of items) {
    const row = el('div', 'manage-row');
    row.dataset.id = item.id;

    const thumb = el('div', 'manage-thumb');
    const artKind = item.posterPath ? 'poster' : item.thumbPath ? 'thumb' : '';
    if (artKind) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = '/api/art/' + encodeURIComponent(item.id) + '?k=' + artKind;
      img.addEventListener('error', () => {
        img.remove();
        thumb.appendChild(el('span', 'mono', '—'));
      });
      thumb.appendChild(img);
    } else {
      thumb.appendChild(el('span', 'mono', '—'));
    }
    row.appendChild(thumb);

    const titleCell = el('div', 'manage-cell');
    titleCell.appendChild(el('strong', null, item.title));
    titleCell.appendChild(el('span', 'hint', item.kind === 'episode' ? item.series + ' · S' + item.season + ' E' + item.episode : 'Movie'));
    row.appendChild(titleCell);

    row.appendChild(el('span', 'manage-file mono', item.path.split(/[\\/]/).pop()));

    row.appendChild(el('span', 'manage-cell', item.kind === 'episode' ? 'Episode' : 'Movie'));
    row.appendChild(el('span', 'manage-cell', item.sizeLabel || '—'));

    const issues = metadataIssues(item);
    const meta = el('span', 'manage-cell');
    meta.appendChild(pill(issues.length ? issues.length + ' missing' : 'Complete', issues.length ? 'warn' : 'good'));
    if (issues.length) meta.title = issues.join(', ');
    row.appendChild(meta);

    const actions = el('div', 'manage-actions');
    const act = (label, handler, extra) => {
      const button = el('button', 'icon-btn' + (extra ? ' ' + extra : ''), label);
      button.type = 'button';
      button.addEventListener('click', handler);
      actions.appendChild(button);
      return button;
    };

    act('Play', () => openPlayer(item, progressFor(item) ? progressFor(item).position : null));
    act('Edit', () => openEditDialog(item));
    act('Poster', () => uploadArtwork(item, 'poster'));
    act('Backdrop', () => uploadArtwork(item, 'backdrop'));
    act('Refresh', async () => {
      try {
        await api('/api/refresh', { method: 'POST', body: { id: item.id } });
        toast('Refreshing metadata for "' + item.title + '"');
        startPolling();
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.appendChild(twoStepButton('Remove', 'Remove?', () => removeFromLibrary(item)));
    act('Delete file', () => openDeleteDialog(item), 'is-danger-btn');
    row.appendChild(actions);

    table.appendChild(row);
  }

  wrap.appendChild(table);
  wrap.appendChild(
    el('p', 'hint', 'Remove takes an item off the shelf and leaves the file alone. Delete file removes it from the disk for good.')
  );
  return wrap;
}

/* ---------------- edit metadata ---------------- */

function openEditDialog(item) {
  const dialog = dialogShell(false);
  const body = el('div', 'dialog-body');
  body.appendChild(el('h2', null, 'Edit details'));
  body.appendChild(el('p', 'hint', 'These values are stored by the server and survive rescans.'));

  const fields = el('div', 'server-fields');
  const makeField = (label, value, placeholder, mono) => {
    const holder = el('label', 'field');
    holder.appendChild(el('span', null, label));
    const input = document.createElement('input');
    input.className = 'control' + (mono ? ' mono' : '');
    input.value = value || '';
    input.placeholder = placeholder || '';
    holder.appendChild(input);
    fields.appendChild(holder);
    return input;
  };

  const titleInput = makeField('Title', item.title, 'Movie or episode title');
  const yearInput = makeField('Year', item.year || '', '2019');
  const seriesInput = item.kind === 'episode' ? makeField('Show', item.series || '', 'Show name') : null;
  const runtimeInput = makeField('Runtime (minutes)', item.runtime ? Math.round(item.runtime / 60) : '', '118');
  const genreInput = makeField('Genres', (item.genres || []).join(', '), 'Action, Drama');
  const overviewInput = document.createElement('textarea');
  overviewInput.className = 'control';
  overviewInput.rows = 4;
  overviewInput.value = item.overview || '';
  overviewInput.placeholder = 'What is this about?';
  const overviewHolder = el('label', 'field');
  overviewHolder.appendChild(el('span', null, 'Description'));
  overviewHolder.appendChild(overviewInput);
  fields.appendChild(overviewHolder);

  body.appendChild(fields);

  const actions = el('div', 'browser-actions');
  const save = el('button', 'btn is-primary', 'Save details');
  save.type = 'button';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api('/api/metadata', {
        method: 'POST',
        body: {
          id: item.id,
          title: titleInput.value,
          year: Number(yearInput.value) || 0,
          series: seriesInput ? seriesInput.value : undefined,
          runtime: (Number(runtimeInput.value) || 0) * 60,
          genres: genreInput.value,
          overview: overviewInput.value,
        },
      });
      toast('Saved details for "' + (titleInput.value || item.title) + '"');
      closeDialog();
      await refreshLibrary();
    } catch (err) {
      toast(err.message, true);
      save.disabled = false;
    }
  });
  actions.appendChild(save);

  const cancel = el('button', 'btn is-ghost', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', closeDialog);
  actions.appendChild(cancel);
  body.appendChild(actions);

  dialog.appendChild(body);
  openDialog(dialog);
}

/* ---------------- artwork ---------------- */

function uploadArtwork(item, kind) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/jpeg,image/png,image/webp';
  picker.addEventListener('change', async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    try {
      toast('Uploading ' + kind + '...');
      const res = await fetch('/api/artwork?id=' + encodeURIComponent(item.id) + '&kind=' + kind, {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': file.type || 'image/jpeg' }, apiKeyHeader()),
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      toast('New ' + kind + ' saved for "' + item.title + '"');
      await refreshLibrary();
    } catch (err) {
      toast(err.message, true);
    }
  });
  picker.click();
}

function apiKeyHeader() {
  const key = window.mattstreamServerKey ? window.mattstreamServerKey() : '';
  return key ? { 'X-MattStream-Key': key } : {};
}

/* ---------------- delete from server ---------------- */

function openDeleteDialog(item) {
  const dialog = dialogShell(false);
  const body = el('div', 'dialog-body');
  body.appendChild(el('h2', null, 'Delete this file from the server?'));

  const fileName = item.path.split(/[\\/]/).pop();
  const warning = el('div', 'delete-warning');
  warning.appendChild(el('strong', null, item.title));
  warning.appendChild(el('span', 'mono', fileName));
  warning.appendChild(el('span', 'hint', item.path));
  body.appendChild(warning);
  body.appendChild(
    el(
      'p',
      'hint',
      'This permanently deletes the file from disk. It is not recoverable by MattStream. To keep the file and only ' +
        'hide it, use Remove instead.'
    )
  );

  const label = el('label', 'field');
  label.appendChild(el('span', null, 'Type the file name to confirm'));
  const input = document.createElement('input');
  input.className = 'control mono';
  input.placeholder = fileName;
  label.appendChild(input);
  body.appendChild(label);

  const actions = el('div', 'browser-actions');
  const confirm = el('button', 'btn is-danger', 'Delete permanently');
  confirm.type = 'button';
  confirm.disabled = true;
  input.addEventListener('input', () => {
    confirm.disabled = input.value !== fileName;
  });
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      await api('/api/media/delete', { method: 'POST', body: { id: item.id, confirm: input.value } });
      toast('Deleted "' + fileName + '" from the server');
      closeDialog();
      await refreshLibrary();
    } catch (err) {
      toast(err.message, true);
      confirm.disabled = false;
    }
  });
  actions.appendChild(confirm);

  const cancel = el('button', 'btn is-ghost', 'Keep the file');
  cancel.type = 'button';
  cancel.addEventListener('click', closeDialog);
  actions.appendChild(cancel);
  body.appendChild(actions);

  dialog.appendChild(body);
  openDialog(dialog);
  setTimeout(() => input.focus(), 60);
}

/* ---------------- default library + first run ---------------- */

const DEFAULT_SERVER_KEY = 'mattstream-default-server';

function defaultServerId() {
  try {
    return localStorage.getItem(DEFAULT_SERVER_KEY) || '';
  } catch (err) {
    return '';
  }
}

function setDefaultServerId(id) {
  try {
    localStorage.setItem(DEFAULT_SERVER_KEY, id);
  } catch (err) {
    /* private mode: the default just will not persist */
  }
}

function defaultServer() {
  return serverById(defaultServerId());
}

// The server this installation ships as its own library (config/defaults.json).
async function readDefaultConfig() {
  try {
    const data = await api('/api/defaults');
    return (data && data.defaultServer) || null;
  } catch (err) {
    return null;
  }
}

async function seedDefaultServer() {
  const wanted = await readDefaultConfig();
  if (!wanted || !wanted.url) return null;
  const list = readServers();
  const existing = list.find((entry) => normalizeUrl(entry.url) === normalizeUrl(wanted.url));
  if (existing) {
    if (!defaultServerId()) setDefaultServerId(existing.id);
    return existing;
  }
  const server = {
    id: 'srv-default',
    name: wanted.name || 'My Library',
    url: normalizeUrl(wanted.url) + '/',
    key: '',
    added: Date.now(),
    seeded: true,
  };
  list.push(server);
  writeServers(list);
  if (!defaultServerId()) setDefaultServerId(server.id);
  return server;
}

/* ---------------- connection chip ---------------- */

let chipTimer = null;

function renderChip(mode, label, detail) {
  const chip = $('#statusChip');
  if (!chip) return;
  chip.dataset.state = mode;
  const dotEl = chip.querySelector('.dot');
  if (dotEl) dotEl.className = 'dot is-' + mode;
  const text = chip.querySelector('.chip-name');
  if (text) text.textContent = label;
  const stateText = chip.querySelector('.chip-state');
  if (stateText) {
    stateText.textContent = mode === 'online' ? 'Online' : mode === 'connecting' ? 'Connecting' : 'Offline';
  }
  chip.title = detail || chip.title;
}

function chipName() {
  const preferred = defaultServer();
  if (preferred && preferred.name) return preferred.name;
  return (state.status && state.status.serverName) || 'This computer';
}

async function refreshChip() {
  renderChip('connecting', chipName());
  const result = await testServer(location.origin);
  if (result.online) {
    renderChip('online', chipName(), location.origin);
    if (state.status && result.status) state.status = Object.assign({}, state.status, result.status);
  } else {
    renderChip('offline', chipName(), result.error + ' - ' + location.origin);
  }
}

function watchConnection() {
  if (chipTimer) return;
  refreshChip();
  chipTimer = setInterval(refreshChip, 15000);
  const chip = $('#statusChip');
  if (chip) chip.addEventListener('click', () => openServersDialog());
  window.addEventListener('online', refreshChip);
  window.addEventListener('offline', refreshChip);
}

/* ---------------- first run ---------------- */

function showFirstRun(defaults) {
  if ($('#firstRunLayer')) return;
  const layer = el('div', 'dialog-layer first-run');
  layer.id = 'firstRunLayer';
  const card = el('div', 'dialog first-run-card');
  card.appendChild(el('h2', null, 'Welcome to MattStream'));
  card.appendChild(
    el(
      'p',
      'hint',
      'MattStream plays the films and shows that live on your own computer. Nothing is shared with anyone ' +
        'unless you give them your address.'
    )
  );

  const choices = el('div', 'first-run-choices');

  // 1. Connect to an existing personal server.
  const connectCard = el('div', 'first-run-option');
  connectCard.appendChild(el('h3', null, 'Connect to my library'));
  connectCard.appendChild(el('p', 'hint', 'You already run MattStream on the computer that holds your media.'));

  const nameInput = document.createElement('input');
  nameInput.className = 'text-input';
  nameInput.placeholder = 'Server name';
  nameInput.value = (defaults && defaults.name) || 'My Home Library';
  connectCard.appendChild(nameInput);

  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.className = 'text-input mono';
  urlInput.placeholder = 'http://192.168.1.24:8096';
  urlInput.value = (defaults && defaults.url) || '';
  connectCard.appendChild(urlInput);

  const keyInput = document.createElement('input');
  keyInput.className = 'text-input';
  keyInput.placeholder = 'Admin key (only if you want to manage that library)';
  connectCard.appendChild(keyInput);

  const feedback = el('p', 'hint', '');
  connectCard.appendChild(feedback);

  const actions = el('div', 'dialog-actions');
  const testButton = el('button', 'btn is-ghost', 'Test connection');
  testButton.type = 'button';
  actions.appendChild(testButton);

  const saveButton = el('button', 'btn is-primary', 'Save as default');
  saveButton.type = 'button';
  actions.appendChild(saveButton);
  connectCard.appendChild(actions);

  testButton.addEventListener('click', async () => {
    const url = normalizeUrl(urlInput.value.trim());
    if (!url) {
      feedback.textContent = 'Enter the address MattStream shows on the computer with your media.';
      return;
    }
    feedback.className = 'hint';
    feedback.textContent = 'Testing ' + url + '...';
    const result = await testServer(url);
    if (result.online) {
      const name = (result.status && result.status.serverName) || url;
      feedback.className = 'hint is-online';
      feedback.textContent =
        'Online - ' + name + ', ' + (result.status.videos || 0) + ' items. Version ' + result.status.version + '.';
      if (!nameInput.value.trim() || nameInput.value.trim() === 'My Home Library') nameInput.value = name;
    } else {
      feedback.className = 'hint is-error';
      feedback.textContent = 'Could not reach it: ' + result.error + '. Check the address and that MattStream is running there.';
    }
  });

  saveButton.addEventListener('click', async () => {
    const url = normalizeUrl(urlInput.value.trim());
    if (!url) {
      feedback.textContent = 'Enter the server address first.';
      return;
    }
    saveButton.disabled = true;
    feedback.className = 'hint';
    feedback.textContent = 'Checking ' + url + '...';
    const result = await testServer(url);
    if (!result.online) {
      feedback.className = 'hint is-error';
      feedback.textContent = 'That server did not answer: ' + result.error + '. Nothing was saved.';
      saveButton.disabled = false;
      return;
    }
    const list = readServers();
    const server =
      list.find((entry) => normalizeUrl(entry.url) === url) ||
      { id: 'srv-' + Date.now().toString(36), name: nameInput.value.trim() || url, url: url + '/', key: '', added: Date.now() };
    server.name = nameInput.value.trim() || server.name;
    server.key = keyInput.value.trim() || server.key || '';
    if (!list.includes(server)) list.push(server);
    writeServers(list);
    setDefaultServerId(server.id);
    setActiveServer(server.id);
    try {
      localStorage.setItem('mattstream-onboarded', '1');
    } catch (err) {
      /* private mode */
    }
    if (server.key) {
      try {
        sessionStorage.setItem('mattstream-admin-key', server.key);
      } catch (err) {
        /* ignore */
      }
    }
    if (!goToServer(server)) {
      layer.remove();
      refreshChip();
      if (typeof refreshLibrary === 'function') refreshLibrary();
    }
  });

  // 2. Start a library on this computer.
  const createCard = el('div', 'first-run-option');
  createCard.appendChild(el('h3', null, 'Create my library'));
  createCard.appendChild(
    el(
      'p',
      'hint',
      adminState.admin
        ? 'This computer can host your library. Add the folders that hold your films and shows and MattStream will scan them.'
        : 'Install MattStream on the computer that holds your media, add your folders there, then come back and connect to that address. Phones and TVs stream from it over Wi-Fi.'
    )
  );
  const createButton = el('button', 'btn is-ghost', adminState.admin ? 'Add my folders' : 'How do I host it?');
  createButton.type = 'button';
  createButton.addEventListener('click', () => {
    if (adminState.admin) {
      layer.remove();
      if (typeof openFoldersDialog === 'function') openFoldersDialog();
    } else {
      createCard.appendChild(
        el(
          'p',
          'hint',
          'On the host computer: open MattStream, choose Library, add the folders with your videos, then use the ' +
            'address shown in Servers here - a LAN address like http://192.168.1.24:8096, never localhost.'
        )
      );
    }
  });
  createCard.appendChild(createButton);

  choices.appendChild(connectCard);
  choices.appendChild(createCard);
  card.appendChild(choices);
  layer.appendChild(card);
  document.body.appendChild(layer);

  setTimeout(() => urlInput.focus(), 80);
}

/* ---------------- boot ---------------- */

/* ---------------- connection watchdog + boot ---------------- */

async function initManage() {
  // Remember the server this page came from.
  let localStatus = null;
  try {
    localStatus = await api('/api/status');
    registerCurrentServer(localStatus.serverName);
  } catch (err) {
    /* offline: the banner below explains it */
  }
  await loadAdmin();

  const serversButton = $('#serversBtn');
  if (serversButton) serversButton.addEventListener('click', () => openServersDialog());

  // This installation's own default library (config/defaults.json).
  const seeded = await seedDefaultServer();
  const config = await readDefaultConfig();
  watchConnection();

  // Where should this device actually sit? A configured library beats an empty
  // local server, but the computer that hosts the library talks to it directly
  // instead of going out to its own LAN address and back.
  const preferred = defaultServer() || serverById(activeServerId());
  const localCount = localStatus && typeof localStatus.videos === 'number' ? localStatus.videos : 0;
  const lanUrls = ((localStatus && localStatus.lanUrls) || []).map(normalizeUrl);
  const preferredIsSelf = preferred ? lanUrls.includes(normalizeUrl(preferred.url)) : false;

  if (preferred && !preferredIsSelf && normalizeUrl(preferred.url) !== location.origin) {
    const bounceKey = 'mattstream-bounced';
    if (!sessionStorage.getItem(bounceKey)) {
      sessionStorage.setItem(bounceKey, '1');
      const result = await testServer(preferred.url);
      if (result.online) {
        location.href = normalizeUrl(preferred.url) + '/';
        return;
      }
      showOfflineBar(preferred);
      renderChip('offline', preferred.name || preferred.url, result.error);
    }
  }

  // A device with nothing to play and no server to talk to gets set up first.
  let onboarded = '0';
  try {
    onboarded = localStorage.getItem('mattstream-onboarded') || '0';
  } catch (err) {
    /* private mode */
  }
  if (!onboarded && localCount === 0 && !preferred) {
    showFirstRun(config);
    return;
  }
  if (localCount > 0 || preferred) {
    try {
      localStorage.setItem('mattstream-onboarded', '1');
    } catch (err) {
      /* ignore */
    }
  }

  if (!adminState.admin) {
    const status = await testServer(location.origin).catch(() => null);
    if (status && !status.online) showOfflineBar(serverById(activeServerId()));
  }
}

function showOfflineBar(server) {
  if ($('#offlineBar')) return;
  const bar = el('div', 'offline-bar');
  bar.id = 'offlineBar';
  bar.appendChild(
    el('span', null, server ? 'Cannot reach ' + (server.name || server.url) + ' - is MattStream running on that computer?'
      : 'Cannot reach this MattStream server.')
  );
  const button = el('button', 'btn is-ghost', 'Server connection');
  button.type = 'button';
  button.addEventListener('click', () => openServersDialog());
  bar.appendChild(button);
  document.body.appendChild(bar);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initManage);
} else {
  initManage();
}
