'use strict';

/* MattStream - match a file to its real movie or show metadata.
   The server holds the API key and does the lookup; this page only ever shows
   the candidates that came back and lets you pick the right one. */

function matchThumb(candidate) {
  const frame = el('div', 'match-thumb');
  if (candidate.posterUrl) {
    const img = document.createElement('img');
    img.src = candidate.posterUrl;
    img.alt = '';
    img.loading = 'lazy';
    frame.appendChild(img);
  } else {
    frame.appendChild(el('span', 'hint', 'no poster'));
  }
  return frame;
}

async function openMatchDialog(item) {
  const dialog = dialogShell(true);
  const body = el('div', 'dialog-body');
  body.appendChild(el('h2', null, 'Match metadata'));
  body.appendChild(
    el(
      'p',
      'hint',
      'MattStream looks the file up by name and uses that entry\'s own title, year, plot and poster - ' +
        'nothing is guessed. If the result is wrong, pick a different one.'
    )
  );

  const file = el('div', 'match-file');
  file.appendChild(el('strong', null, item.title || item.file || 'This file'));
  file.appendChild(el('span', 'mono', item.file || item.path || ''));
  body.appendChild(file);

  const form = el('div', 'match-form');
  const query = document.createElement('input');
  query.type = 'search';
  query.className = 'text-input';
  query.placeholder = 'Movie or show name';
  query.value = item.matchQuery || guessName(item);
  form.appendChild(query);

  const searchButton = el('button', 'btn is-primary', 'Search');
  searchButton.type = 'button';
  form.appendChild(searchButton);
  body.appendChild(form);

  const scopeRow = el('label', 'match-scope');
  const scopeBox = document.createElement('input');
  scopeBox.type = 'checkbox';
  scopeBox.checked = item.kind === 'episode';
  scopeRow.appendChild(scopeBox);
  scopeRow.appendChild(el('span', null, 'Apply to every episode of this show'));
  scopeRow.hidden = item.kind !== 'episode';
  body.appendChild(scopeRow);

  const message = el('p', 'hint', '');
  body.appendChild(message);

  const results = el('div', 'match-results');
  body.appendChild(results);

  const keyArea = el('div', 'match-key');
  keyArea.hidden = true;
  keyArea.appendChild(
    el(
      'p',
      'hint',
      'Real posters and titles come from The Movie Database. Paste a free TMDB API key once - ' +
        'it is stored on the server, never in the page.'
    )
  );
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.className = 'text-input';
  keyInput.placeholder = 'TMDB API key (v3)';
  keyArea.appendChild(keyInput);
  const keySave = el('button', 'btn is-primary', 'Save key');
  keySave.type = 'button';
  keyArea.appendChild(keySave);
  body.appendChild(keyArea);

  const close = el('button', 'btn is-ghost', 'Close');
  close.type = 'button';
  close.addEventListener('click', closeDialog);
  const actions = el('div', 'dialog-actions');
  actions.appendChild(close);
  body.appendChild(actions);

  dialog.appendChild(body);
  openDialog(dialog);

  function guessName(entry) {
    const raw = String(entry.file || entry.title || '').replace(/\.[a-z0-9]{2,4}$/i, '');
    return raw
      .replace(/[Ss]\d{1,2}[\s._-]?[Ee]\d{1,3}.*$/, '')
      .replace(/\b(19|20)\d{2}\b.*$/, '')
      .replace(/[._]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  keySave.addEventListener('click', async () => {
    const value = keyInput.value.trim();
    if (!value) return;
    keySave.disabled = true;
    try {
      await api('/api/match/key', { method: 'POST', body: { key: value } });
      toast('TMDB key saved on the server');
      keyArea.hidden = true;
      await runSearch();
    } catch (err) {
      toast(err.message, true);
    } finally {
      keySave.disabled = false;
    }
  });

  async function apply(candidate) {
    message.textContent = 'Applying "' + candidate.title + '"...';
    try {
      await api('/api/match/apply', {
        method: 'POST',
        body: {
          id: item.id,
          tmdbId: candidate.tmdbId,
          mediaType: candidate.mediaType,
          scope: scopeBox.checked && item.kind === 'episode' ? 'series' : 'item',
        },
      });
      toast('Matched "' + item.title + '" to ' + candidate.title);
      closeDialog();
      if (typeof refreshLibrary === 'function') await refreshLibrary();
    } catch (err) {
      message.textContent = err.message;
      message.classList.add('is-error');
    }
  }

  function renderCandidates(candidates) {
    results.textContent = '';
    if (!candidates.length) {
      message.textContent = 'No matches came back for that name. Try the exact title, or the title as it appears on TMDB.';
      return;
    }
    message.textContent = candidates.length + ' possible matches - pick the right one.';
    message.classList.remove('is-error');
    for (const candidate of candidates) {
      const row = el('div', 'match-row');
      row.appendChild(matchThumb(candidate));
      const info = el('div', 'match-info');
      info.appendChild(el('strong', null, candidate.title || 'Untitled'));
      const meta = [candidate.year, candidate.mediaType === 'tv' ? 'TV show' : 'Movie', candidate.vote ? candidate.vote + '/10' : '']
        .filter(Boolean)
        .join(' - ');
      info.appendChild(el('span', 'hint', meta));
      if (candidate.overview) info.appendChild(el('p', 'match-overview', candidate.overview));
      row.appendChild(info);
      const use = el('button', 'btn is-primary', 'Use this');
      use.type = 'button';
      use.addEventListener('click', () => apply(candidate));
      row.appendChild(use);
      results.appendChild(row);
    }
  }

  async function runSearch() {
    const value = query.value.trim();
    if (!value) {
      message.textContent = 'Type the movie or show name first.';
      return;
    }
    searchButton.disabled = true;
    message.classList.remove('is-error');
    message.textContent = 'Searching...';
    results.textContent = '';
    try {
      const data = await api('/api/match/search', {
        method: 'POST',
        body: { id: item.id, query: value, kind: item.kind },
      });
      renderCandidates(data.candidates || []);
    } catch (err) {
      message.textContent = err.message;
      message.classList.add('is-error');
      if (err.needsKey || /api key/i.test(err.message || '')) keyArea.hidden = false;
    } finally {
      searchButton.disabled = false;
    }
  }

  searchButton.addEventListener('click', runSearch);
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    }
  });
  setTimeout(() => query.focus(), 60);
}

window.openMatchDialog = openMatchDialog;
