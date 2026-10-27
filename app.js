/* Travel Podcasts: reads episodes aloud with the device's own text-to-speech voices.
 * No build step, no dependencies. Episodes come from library.json (built from episodes/*.md)
 * plus any episodes the user pasted in (kept in localStorage on this device). */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  const WPM = 150;
  const SPEEDS = [0.85, 1, 1.15, 1.3, 1.5, 1.75];

  /* ---------- storage (always wrapped: it can be blocked or full) ---------- */
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
  };

  const settings = Object.assign(
    { rate: 1, voiceURI: '', wake: true, autonext: true, pron: '', speakerVoices: {}, engine: 'natural' },
    store.get('tp.settings', {})
  );
  if (settings.engine === 'auto' && !settings.engineChosen) settings.engine = 'natural'; // 'auto' was only ever the old default
  const saveSettings = () => store.set('tp.settings', settings);
  let progress = store.get('tp.progress', {}); // { [episodeId]: { ch, u } }
  const saveProgress = () => store.set('tp.progress', progress);

  /* ---------- episode parsing (same rules as tools/build.py) ---------- */
  const clean = (t) =>
    t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]+/g, '').replace(/[ \t]+/g, ' ').trim();

  function parseEpisode(raw, fallbackTitle, id) {
    let meta = {};
    let body = raw.replace(/\r\n?/g, '\n');
    const fm = body.match(/^---\n([\s\S]*?)\n---\n/);
    if (fm) {
      fm[1].split('\n').forEach((line) => {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      body = body.slice(fm[0].length);
    }
    const h1 = body.match(/^# +(.+)$/m);
    const title = meta.title || (h1 && clean(h1[1])) || fallbackTitle || 'Untitled episode';
    const parts = body.split(/^## +/m).slice(1);
    const chapters = [];
    const sources = [];
    let notes = '';
    parts.forEach((sec) => {
      const nl = sec.indexOf('\n');
      const head = clean(nl < 0 ? sec : sec.slice(0, nl));
      const rest = nl < 0 ? '' : sec.slice(nl + 1);
      const low = head.toLowerCase();
      if (low.startsWith('notes before')) { notes = clean(rest); return; }
      if (low.startsWith('sources')) {
        rest.split('\n').forEach((line) => {
          const m = line.match(/^\s*[-*]\s*\[(.+?)\]\((.+?)\)/);
          if (m) sources.push({ title: clean(m[1]), url: m[2] });
        });
        return;
      }
      const paragraphs = rest.split(/\n\s*\n/).map((p) => clean(p).replace(/\s*\n\s*/g, ' ')).filter(Boolean);
      if (paragraphs.length) {
        chapters.push({ title: head.replace(/^Chapter\s+\d+:\s*/i, ''), label: head, paragraphs });
      }
    });
    if (!chapters.length) {
      // Plain text with no "##" sections: treat the whole thing as one chapter.
      const noH1 = body.replace(/^# .*$/m, '');
      const paragraphs = noH1.split(/\n\s*\n/).map((p) => clean(p).replace(/\s*\n\s*/g, ' ')).filter(Boolean);
      if (paragraphs.length) chapters.push({ title: title, label: title, paragraphs });
    }
    const words = chapters.reduce((n, c) => n + c.paragraphs.reduce((m, p) => m + p.split(/\s+/).length, 0), 0);
    return {
      id: id || 'user-' + Date.now(),
      title, place: meta.place || '', blurb: meta.blurb || '',
      order: parseFloat(meta.order || '999'), words, minutes: Math.max(1, Math.round(words / WPM)),
      notes, chapters, sources, speakers: detectSpeakers(meta, chapters),
    };
  }

  /* Dialogue episodes: a paragraph that starts with "Name: " is spoken by that speaker.
   * Speakers come from the "speakers:" front-matter line, or are auto-detected when two or
   * more different names each open at least two paragraphs. (Same rule as tools/build.py.) */
  const SPEAKER_RE = /^([A-ZÀ-Ý][A-Za-zÀ-ÿ'’-]{0,19}(?: [A-ZÀ-Ý][A-Za-zÀ-ÿ'’-]{0,19})?): /;
  function detectSpeakers(meta, chapters) {
    if (meta.speakers) return meta.speakers.split(',').map((s) => s.trim()).filter(Boolean);
    const counts = new Map();
    chapters.forEach((c) => c.paragraphs.forEach((p) => {
      const m = p.match(SPEAKER_RE);
      if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }));
    const names = [...counts].filter(([, k]) => k >= 2).map(([n]) => n);
    return names.length >= 2 ? names : [];
  }

  /* ---------- sentence splitting for speech ---------- */
  const ABBR = /\b(?:Mr|Mrs|Ms|Dr|St|Ste|Mt|Jr|Sr|Prof|vs|etc|No|Fr|Gen|Col|Capt|Sgt|Lt|Ft|approx|c|ca)\.$/;

  function splitSentences(par) {
    const raw = par.split(/(?<=[.!?]["'”’)\]]?)\s+(?=["'“‘(]?[A-Z0-9À-ſ])/);
    const merged = [];
    raw.forEach((piece) => {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && (ABBR.test(prev) || prev.length < 30)) merged[merged.length - 1] = prev + ' ' + piece;
      else merged.push(piece);
    });
    // Very long sentences are broken at commas/semicolons so speech never stalls.
    const out = [];
    merged.forEach((s) => {
      if (s.length <= 260) { out.push(s); return; }
      let cur = '';
      s.split(/(?<=[,;:])\s+/).forEach((frag) => {
        if (cur && (cur + ' ' + frag).length > 220) { out.push(cur); cur = frag; }
        else cur = cur ? cur + ' ' + frag : frag;
      });
      if (cur) out.push(cur);
    });
    return out;
  }

  // Returns { units, who } where who[paragraphIndex] is the speaker name or null (narrator).
  function buildUnits(chapter, speakers) {
    const units = [];
    const who = [];
    chapter.paragraphs.forEach((text, pi) => {
      let speaker = null;
      const m = text.match(SPEAKER_RE);
      if (m && speakers && speakers.includes(m[1])) { speaker = m[1]; text = text.slice(m[0].length); }
      who[pi] = speaker;
      splitSentences(text).forEach((t) => units.push({ p: pi, text: t, speaker }));
    });
    return { units, who };
  }

  /* ---------- library ---------- */
  let library = [];
  let userEps = store.get('tp.user', []);

  async function loadLibrary() {
    let shipped = [];
    try {
      const r = await fetch('library.json', { cache: 'no-cache' });
      if (r.ok) shipped = (await r.json()).episodes || [];
    } catch (e) { /* offline and not cached yet: user episodes still work */ }
    try {
      const r = await fetch('audio/manifest.json', { cache: 'no-cache' });
      audioManifest = r.ok ? await r.json() : null;
    } catch (e) { audioManifest = null; }
    library = shipped.concat(userEps.map((e) => Object.assign({ user: true }, e)));
    library.sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));
  }

  const epWords = (ep, upToChapter) =>
    ep.chapters.slice(0, upToChapter).reduce((n, c) => n + c.paragraphs.reduce((m, p) => m + p.split(/\s+/).length, 0), 0);

  function percent(ep) {
    const pr = progress[ep.id];
    if (!pr) return 0;
    if (pr.done) return 100;
    const ch = ep.chapters[pr.ch];
    if (!ch) return 0;
    const chWords = ch.paragraphs.reduce((m, p) => m + p.split(/\s+/).length, 0);
    const frac = pr.n ? Math.min(1, pr.u / pr.n) : 0;
    const total = epWords(ep, ep.chapters.length) || 1;
    return Math.round(((epWords(ep, pr.ch) + chWords * frac) / total) * 100);
  }

  /* ---------- offline audio (Cache API; the service worker serves it, including seeking) ---------- */
  const AUDIO_CACHE = 'tp-audio-v1';
  let offlineKeys = new Set();
  async function refreshOffline() {
    try {
      const c = await caches.open(AUDIO_CACHE);
      offlineKeys = new Set((await c.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search));
    } catch (e) { offlineKeys = new Set(); }
  }
  function offlineUrls(e) {
    const out = [];
    e.chapters.forEach((_c, n) => { if (hasAudio(e, n)) out.push(audioUrl(e, n, 'mp3'), audioUrl(e, n, 'json')); });
    return out;
  }
  function savedOffline(e) {
    const urls = offlineUrls(e);
    if (!urls.length) return false;
    const have = new Set([...offlineKeys].map((k) => k.replace(/^.*?\/(audio\/)/, '$1')));
    return urls.every((u) => have.has(u));
  }
  async function saveOffline(e, btn) {
    const urls = offlineUrls(e);
    const parts = urls.length / 2;
    try {
      // make sure the app itself and the audio list are cached too, so it opens with no signal
      await Promise.all(['audio/manifest.json', 'library.json'].map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
      const cache = await caches.open(AUDIO_CACHE);
      for (let i = 0; i < urls.length; i++) {
        btn.textContent = `Saving ${Math.floor(i / 2) + 1} of ${parts}\u2026`;
        btn.disabled = true;
        const r = await fetch(urls[i]);
        if (!r.ok) throw new Error('http ' + r.status);
        await cache.put(urls[i], r);
      }
      // drop older versions of this episode's audio
      const keep = new Set(urls.map((u) => new URL(u, location.href).href));
      const prefix = new URL('audio/' + encodeURIComponent(e.id) + '/', location.href).href;
      for (const req of await cache.keys()) if (req.url.startsWith(prefix) && !keep.has(req.url)) await cache.delete(req);
      showToast('Saved for offline listening.');
    } catch (err) {
      showToast('Saving stopped. Check your connection and try again.');
    }
    await refreshOffline(); renderLibrary();
  }
  async function removeOffline(e, silent) {
    if (!silent && !confirm('Remove the saved audio for "' + e.title + '" from this phone?')) return;
    try {
      const cache = await caches.open(AUDIO_CACHE);
      const prefix = new URL('audio/' + encodeURIComponent(e.id) + '/', location.href).href;
      for (const req of await cache.keys()) if (req.url.startsWith(prefix)) await cache.delete(req);
    } catch (err) { /* ignore */ }
    await refreshOffline(); renderLibrary();
  }

  /* ---------- organizing: remove/hide, place filter, playlists ---------- */
  let hidden = store.get('tp.hidden', []);
  let playlists = store.get('tp.playlists', []);
  let tab = store.get('tp.tab', 'episodes');
  let placeFilter = '';
  let showHidden = false;
  let curPl = null; // the playlist the open episode is being played from
  const saveHidden = () => store.set('tp.hidden', hidden);
  const savePlaylists = () => store.set('tp.playlists', playlists);
  const epById = (id) => library.find((e) => e.id === id);
  const plById = (id) => playlists.find((p) => p.id === id);
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const plMinutes = (p) => p.items.reduce((n, id) => n + (epById(id) ? epById(id).minutes : 0), 0);

  function buildCard(e, removed) {
    const li = mk('li', 'card' + (removed ? ' removed' : ''));
    const pct = percent(e);
    li.append(mk('span', 'place', removed ? 'Removed' : e.place || (e.user ? 'Added by you' : 'Episode')));
    li.append(mk('h2', '', e.title));
    if (e.blurb) li.append(mk('p', '', e.blurb));
    const ac = audioCount(e);
    const audioNote = ac === e.chapters.length ? ' · natural voice' : ac ? ` · natural voice for ${ac} of ${e.chapters.length} parts` : (naturalOnly(e) ? ' · audio is being made' : '');
    li.append(mk('div', 'meta', `${e.chapters.length} parts · about ${e.minutes} min${audioNote}${pct ? ' · ' + (pct >= 100 ? 'finished' : pct + '% heard') : ''}`));
    if (!removed && pct > 0 && pct < 100) {
      const bar = mk('div', 'progress', ''); const fill = document.createElement('div'); fill.style.width = pct + '%'; bar.append(fill); li.append(bar);
    }
    const actions = mk('div', 'actions', '');
    if (removed) {
      const back = mk('button', 'ghost small', 'Bring back');
      back.addEventListener('click', () => { hidden = hidden.filter((id) => id !== e.id); saveHidden(); renderLibrary(); });
      actions.append(back);
      li.append(actions);
      return li;
    }
    const go = mk('button', 'primary', pct > 0 && pct < 100 ? 'Resume' : pct >= 100 ? 'Listen again' : 'Listen');
    go.addEventListener('click', () => {
      if (pct >= 100) { delete progress[e.id]; saveProgress(); }
      location.hash = '#/e/' + encodeURIComponent(e.id);
    });
    actions.append(go);
    if (ac && 'caches' in window) {
      const saved = savedOffline(e);
      const off = mk('button', 'ghost small', saved ? 'Saved offline ✓' : 'Save for offline');
      if (saved) { off.addEventListener('click', () => removeOffline(e)); off.title = 'Tap to remove the saved audio'; }
      else off.addEventListener('click', () => saveOffline(e, off));
      actions.append(off);
    }
    const more = mk('button', 'icon-btn more', '⋯');
    more.setAttribute('aria-label', 'More options for ' + e.title);
    more.addEventListener('click', () => openEpOptions(e));
    actions.append(more);
    li.append(actions);
    return li;
  }

  function renderEpisodes() {
    const visible = library.filter((e) => !hidden.includes(e.id));
    const places = [...new Set(visible.map((e) => e.place).filter(Boolean))];
    if (placeFilter && !places.includes(placeFilter)) placeFilter = '';
    const chips = $('place-chips');
    chips.textContent = '';
    chips.hidden = places.length < 2;
    ['', ...places].forEach((pl) => {
      const b = mk('button', 'chip-btn', pl || 'All');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(placeFilter === pl));
      b.addEventListener('click', () => { placeFilter = pl; renderLibrary(); });
      chips.append(b);
    });
    const ul = $('cards');
    ul.textContent = '';
    const shown = visible.filter((e) => !placeFilter || e.place === placeFilter);
    if (!shown.length) ul.append(mk('li', 'fine', library.length ? 'Nothing here.' : 'No episodes yet. Add one below.'));
    shown.forEach((e) => ul.append(buildCard(e)));
    const hid = library.filter((e) => hidden.includes(e.id));
    const btn = $('show-hidden');
    btn.hidden = !hid.length;
    btn.textContent = showHidden ? 'Stop showing hidden episodes' : `Show ${hid.length} hidden episode${hid.length === 1 ? '' : 's'}`;
    if (showHidden) hid.forEach((e) => ul.append(buildCard(e, true)));
  }

  function renderPlaylists() {
    const ul = $('pl-cards');
    ul.textContent = '';
    if (!playlists.length) ul.append(mk('li', 'fine', 'No playlists yet. Make one for a trip, a commute or a topic, then add episodes with the ⋯ button on any episode.'));
    playlists.forEach((p) => {
      const li = mk('li', 'card');
      li.append(mk('h2', '', p.name));
      const n = p.items.filter(epById).length;
      li.append(mk('div', 'meta', `${n} episode${n === 1 ? '' : 's'} · about ${plMinutes(p)} min`));
      const actions = mk('div', 'actions', '');
      const open = mk('button', 'primary', 'Open');
      open.addEventListener('click', () => { location.hash = '#/p/' + encodeURIComponent(p.id); });
      actions.append(open);
      li.append(actions);
      ul.append(li);
    });
  }

  function renderLibrary() {
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    $('pane-episodes').hidden = tab !== 'episodes';
    $('pane-playlists').hidden = tab !== 'playlists';
    if (tab === 'episodes') renderEpisodes(); else renderPlaylists();
  }

  function askName(title, initial, cb) {
    $('name-title').textContent = title;
    $('name-input').value = initial || '';
    $('name-save').onclick = () => {
      const v = $('name-input').value.trim();
      if (!v) return;
      $('dlg-name').close();
      cb(v);
    };
    $('dlg-name').showModal();
  }

  function removeUserEp(e) {
    if (!confirm('Delete "' + e.title + '" from this phone? This cannot be undone.')) return;
    userEps = userEps.filter((x) => x.id !== e.id); store.set('tp.user', userEps);
    delete progress[e.id]; saveProgress();
    playlists.forEach((p) => { p.items = p.items.filter((id) => id !== e.id); }); savePlaylists();
    loadLibrary().then(renderLibrary);
  }

  // ---- GitHub access (token lives only in this phone's browser) ----
  const GH_REPO = 'fijsurge/travel-podcasts';
  const GH_API = 'https://api.github.com';
  const ghToken = () => (store.get('tp.gh', {}).token || '').trim();
  async function ghFetch(path, opts) {
    const o = opts || {};
    const res = await fetch(GH_API + path, {
      method: o.method || 'GET',
      headers: Object.assign({
        'Authorization': 'Bearer ' + ghToken(),
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }, o.body ? { 'Content-Type': 'application/json' } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (err) { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
  }
  function ghProblem(r) {
    if (r.status === 401) return 'GitHub did not accept the key. It may have expired or been mistyped.';
    if (r.status === 403 || r.status === 404) return 'The key cannot change this repository. It needs "Contents: Read and write" for ' + GH_REPO + '.';
    return 'GitHub said: ' + ((r.data && r.data.message) || r.status);
  }
  async function checkGh() {
    const out = $('gh-status');
    if (!ghToken()) { out.textContent = 'No key saved. Deleting from GitHub is switched off.'; return; }
    out.textContent = 'Checking\u2026';
    try {
      const r = await ghFetch('/repos/' + GH_REPO);
      if (!r.ok) { out.textContent = ghProblem(r); return; }
      const perms = r.data && r.data.permissions;
      out.textContent = perms && perms.push === false
        ? 'The key works but can only read ' + GH_REPO + '. Make a new one with Contents: Read and write.'
        : 'Connected. This phone can change ' + GH_REPO + '.';
    } catch (err) { out.textContent = 'Could not reach GitHub. Check your connection.'; }
  }

  async function deleteFromGitHub(e) {
    if (!ghToken()) { showToast('Add your GitHub key in Settings first.'); $('settings-btn').click(); return; }
    if (!confirm('Delete "' + e.title + '" from GitHub?\n\n' +
      '\u2022 It disappears for every device within a few minutes.\n' +
      '\u2022 Its audio is deleted from the site, which frees the space.\n' +
      '\u2022 GitHub keeps the old version in its history, so Claude can restore it if needed.\n\n' +
      'This is not the same as hiding it on this phone.')) return;
    showToast('Deleting from GitHub\u2026');
    const path = '/repos/' + GH_REPO + '/contents/episodes/' + encodeURIComponent(e.id) + '.md';
    try {
      const cur = await ghFetch(path + '?ref=main');
      if (cur.status === 404) { showToast('It is already gone from GitHub.'); }
      else if (!cur.ok) { showToast(ghProblem(cur)); return; }
      else {
        const del = await ghFetch(path, { method: 'DELETE', body: { message: 'Delete episode ' + e.id + ' (from the app)', sha: cur.data.sha, branch: 'main' } });
        if (!del.ok) { showToast(ghProblem(del)); return; }
        showToast('Deleted. The site updates in a few minutes.');
      }
    } catch (err) { showToast('Could not reach GitHub. Nothing was deleted.'); return; }
    // tidy this phone straight away so it does not wait for the site to rebuild
    if (!hidden.includes(e.id)) { hidden.push(e.id); saveHidden(); }
    delete progress[e.id]; saveProgress();
    playlists.forEach((p) => { p.items = p.items.filter((id) => id !== e.id); }); savePlaylists();
    try { await removeOffline(e, true); } catch (err) { /* nothing saved */ }
    renderLibrary();
  }

  function openEpOptions(e) {
    $('ep-opts-title').textContent = e.title;
    const box = $('ep-opts');
    box.textContent = '';
    const add = (label, hint, fn, cls) => {
      const b = mk('button', cls || 'ghost wide', label);
      b.type = 'button';
      b.addEventListener('click', () => { $('dlg-ep').close(); fn(); });
      box.append(b, mk('p', 'fine opt-hint', hint));
    };
    add('Add to a playlist', 'Group episodes for a trip. Only on this phone.', () => openPlPick(e));
    if (e.user) {
      add('Delete from this phone', 'You added this one yourself. It is not on GitHub, so this deletes it for good.', () => removeUserEp(e), 'ghost wide danger');
    } else {
      add('Hide on this phone', 'Only hides it here. Nothing changes on GitHub and you can bring it back.', () => {
        hidden.push(e.id); saveHidden(); renderLibrary();
        showToast('Hidden. Bring it back with "Show hidden episodes".');
      });
      add('Delete from GitHub\u2026', 'Removes it for every device and frees its audio on the site. Needs your GitHub key in Settings.', () => deleteFromGitHub(e), 'ghost wide danger');
    }
    $('dlg-ep').showModal();
  }

  function openPlPick(e) {
    const box = $('pl-pick');
    const draw = () => {
      box.textContent = '';
      if (!playlists.length) box.append(mk('p', 'fine', 'No playlists yet.'));
      playlists.forEach((p) => {
        const row = mk('label', 'field check');
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = p.items.includes(e.id);
        cb.addEventListener('change', () => {
          if (cb.checked) { if (!p.items.includes(e.id)) p.items.push(e.id); } else p.items = p.items.filter((x) => x !== e.id);
          savePlaylists();
        });
        row.append(cb, document.createTextNode(' ' + p.name));
        box.append(row);
      });
    };
    draw();
    $('pl-pick-new').onclick = () => {
      $('dlg-pl').close();
      askName('New playlist', '', (name) => {
        playlists.push({ id: 'pl-' + Date.now().toString(36), name, items: [e.id] });
        savePlaylists(); renderLibrary(); showToast('Added to "' + name + '".');
      });
    };
    $('dlg-pl').showModal();
  }

  function renderPlaylistView(p) {
    p.items = p.items.filter(epById);
    const ul = $('pl-items');
    ul.textContent = '';
    $('pl-play').hidden = !p.items.length;
    $('pl-play').onclick = () => {
      location.hash = '#/e/' + encodeURIComponent(p.items[0]) + '?pl=' + encodeURIComponent(p.id) + '&play=1';
    };
    if (!p.items.length) ul.append(mk('li', 'fine', 'This playlist is empty. Use the ⋯ button on an episode to add it.'));
    p.items.forEach((eid, i) => {
      const e = epById(eid);
      const li = mk('li', 'row');
      const t = mk('button', 'row-title', '');
      t.append(mk('span', '', e.title), mk('small', '', `${e.place ? e.place + ' · ' : ''}about ${e.minutes} min`));
      t.addEventListener('click', () => { location.hash = '#/e/' + encodeURIComponent(eid) + '?pl=' + encodeURIComponent(p.id); });
      li.append(t);
      const btn = (label, aria, fn, disabled) => {
        const b = mk('button', 'icon-btn', label); b.setAttribute('aria-label', aria); b.disabled = !!disabled;
        b.addEventListener('click', fn); li.append(b);
      };
      const move = (d) => () => { const j = i + d; [p.items[i], p.items[j]] = [p.items[j], p.items[i]]; savePlaylists(); renderPlaylistView(p); };
      btn('↑', 'Move up', move(-1), i === 0);
      btn('↓', 'Move down', move(1), i === p.items.length - 1);
      btn('✕', 'Remove from playlist', () => { p.items.splice(i, 1); savePlaylists(); renderPlaylistView(p); });
      ul.append(li);
    });
    $('pl-rename').onclick = () => askName('Rename playlist', p.name, (name) => { p.name = name; savePlaylists(); $('title').textContent = name; });
    $('pl-delete').onclick = () => {
      if (!confirm('Delete the playlist "' + p.name + '"? The episodes stay in your library.')) return;
      playlists = playlists.filter((x) => x.id !== p.id); savePlaylists(); location.hash = '';
    };
  }

  function nextInPlaylist() {
    const p = curPl && plById(curPl);
    if (!p || !ep) return null;
    const i = p.items.indexOf(ep.id);
    return i >= 0 ? p.items.slice(i + 1).find(epById) || null : null;
  }

  /* ---------- player state ---------- */
  let ep = null, chIdx = 0, units = [], spans = [], idx = 0;
  let playing = false, token = 0, lastStart = 0, watchdog = null;
  let audioManifest = null; // audio/manifest.json: which chapters have generated audio

  function pronounce(text) {
    const lines = (settings.pron || '').split('\n');
    lines.forEach((line) => {
      const i = line.indexOf('=');
      if (i < 1) return;
      const from = line.slice(0, i).trim(), to = line.slice(i + 1).trim();
      if (!from) return;
      const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp('\\b' + esc + '\\b', 'g'), to);
    });
    return text;
  }

  /* voices */
  let voices = [];
  function voiceScore(v) {
    let s = 0;
    if (/^en/i.test(v.lang)) s += 10;
    if (/natural|neural|premium|enhanced/i.test(v.name)) s += 3;
    if (/google/i.test(v.name)) s += 2;
    if (/en[-_](GB|US)/i.test(v.lang)) s += 1;
    if (v.localService) s += 1;
    return s;
  }
  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices().slice().sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name));
    const sel = $('voice');
    sel.textContent = '';
    if (!voices.length) {
      const o = document.createElement('option'); o.textContent = 'Phone default'; o.value = ''; sel.append(o); return;
    }
    voices.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`; sel.append(o);
    });
    sel.value = currentVoice() ? currentVoice().voiceURI : voices[0].voiceURI;
  }
  function currentVoice() {
    if (!voices.length) return null;
    return voices.find((v) => v.voiceURI === settings.voiceURI) || voices[0];
  }

  // Voice for a named speaker: the one chosen in Settings, otherwise the next voices in the same
  // language after the narrator's voice, so each speaker sounds different without any setup.
  function voiceFor(speaker) {
    if (!speaker || !ep || !ep.speakers) return currentVoice();
    const saved = settings.speakerVoices[speaker];
    const hit = saved && voices.find((v) => v.voiceURI === saved);
    if (hit) return hit;
    const base = currentVoice();
    if (!base) return null;
    const pool = voices.filter((v) => v.lang.slice(0, 2) === base.lang.slice(0, 2));
    const i = Math.max(0, ep.speakers.indexOf(speaker));
    return pool[(Math.max(0, pool.indexOf(base)) + i) % pool.length] || base;
  }
  // If two speakers end up on the same voice (only one installed), nudge the pitch to tell them apart.
  function pitchFor(speaker, voice) {
    if (!speaker || !ep || !ep.speakers) return 1;
    const i = ep.speakers.indexOf(speaker);
    for (let j = 0; j < i; j++) if (voiceFor(ep.speakers[j]) === voice) return [1, 0.8, 1.2, 0.9][i % 4];
    return 1;
  }
  const SPEAKER_COLORS = ['#1d6fa5', '#b5532b', '#4a7c3f', '#8a4fa0'];

  /* keep-alive audio + media session: lets playback continue and shows lock-screen controls */
  let keepAlive = null;
  function silentWavUrl() {
    const rate = 8000, n = rate * 2, buf = new ArrayBuffer(44 + n), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    w(36, 'data'); dv.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function startKeepAlive() {
    try {
      if (!keepAlive) { keepAlive = new Audio(silentWavUrl()); keepAlive.loop = true; }
      const p = keepAlive.play(); if (p && p.catch) p.catch(() => {});
    } catch (e) { /* optional */ }
  }
  function stopKeepAlive() { try { if (keepAlive) keepAlive.pause(); } catch (e) { /* optional */ } }

  function updateMedia() {
    if (!('mediaSession' in navigator) || !ep) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: ep.chapters[chIdx].label, artist: ep.title, album: 'Travel Podcasts',
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    } catch (e) { /* optional */ }
  }
  function bindMediaKeys() {
    if (!('mediaSession' in navigator)) return;
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) { /* unsupported */ } };
    set('play', () => play());
    set('pause', () => pause());
    set('previoustrack', () => gotoChapter(chIdx - 1, playing));
    set('nexttrack', () => gotoChapter(chIdx + 1, playing));
    set('seekbackward', () => seekBy(-15));
    set('seekforward', () => seekBy(15));
    set('seekto', (d) => { if (mode === 'audio' && d && d.seekTime != null) audioEl.currentTime = d.seekTime; });
    set('stop', () => pause());
  }

  /* screen wake lock */
  let wl = null;
  async function lockScreen() {
    if (!settings.wake || !('wakeLock' in navigator) || wl) return;
    try {
      wl = await navigator.wakeLock.request('screen');
      wl.addEventListener('release', () => { wl = null; });
    } catch (e) { wl = null; }
  }
  function unlockScreen() { if (wl) { wl.release().catch(() => {}); wl = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playing) lockScreen();
  });

  function showToast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(showToast.h); showToast.h = setTimeout(() => { t.hidden = true; }, 3500);
  }

  /* ---------- natural audio (MP3 files made by tools/make_audio.py) ---------- */
  const audioEl = new Audio();
  audioEl.preload = 'auto';
  let mode = 'speech'; // 'audio' when the open chapter has generated audio, else the phone's voice
  let loadSeq = 0, lastPos = 0, pendingSeek = null, switching = false;
  const jsonCache = new Map();
  const audioFailed = new Set();
  const audioUrl = (e, n, ext) => `audio/${encodeURIComponent(e.id)}/${String(n).padStart(2, '0')}.${ext}?v=${e.chapters[n].hash}`;

  function hasAudio(e, n) {
    const a = audioManifest && audioManifest.episodes && audioManifest.episodes[e.id] && audioManifest.episodes[e.id].chapters[String(n)];
    return a && a.hash === e.chapters[n].hash ? a : null;
  }
  const engine = () => settings.engine || 'natural'; // natural = only the generated voices; auto = fall back to the phone voice; phone = always the phone voice
  const naturalOnly = (e) => engine() === 'natural' && !(e && e.user); // episodes you pasted in have no generated audio
  const audioEntry = (e, n) => (engine() === 'phone' ? null : hasAudio(e, n));
  const audioCount = (e) => e.chapters.reduce((k, _c, n) => k + (hasAudio(e, n) ? 1 : 0), 0);

  async function fetchChapterJson(e, n) {
    const url = audioUrl(e, n, 'json');
    let j = jsonCache.get(url);
    if (!j) {
      const r = await fetch(url);
      if (!r.ok) throw new Error('missing');
      j = await r.json();
      jsonCache.set(url, j);
    }
    if (j.hash !== e.chapters[n].hash) throw new Error('stale');
    return j;
  }

  async function loadUnits(e, n) {
    if (audioEntry(e, n) && !audioFailed.has(e.id + ':' + n)) {
      try { return { units: (await fetchChapterJson(e, n)).units, audio: true }; } catch (err) { /* fall back to the phone voice */ }
    }
    return { units: buildUnits(e.chapters[n], e.speakers).units, audio: false };
  }

  function seekToUnit(i) {
    const t = units[i] && units[i].t != null ? units[i].t : 0;
    if (audioEl.readyState >= 1) { pendingSeek = null; audioEl.currentTime = t; } else pendingSeek = t;
  }
  function seekBy(sec) {
    if (mode === 'audio') {
      const d = audioEl.duration || Infinity;
      audioEl.currentTime = Math.min(Math.max(0, audioEl.currentTime + sec), d);
    } else skip(sec > 0 ? 3 : -3);
  }
  function setPosition() {
    if (mode !== 'audio' || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = audioEl.duration;
    if (!d || !isFinite(d)) return;
    try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: audioEl.playbackRate || 1, position: Math.min(audioEl.currentTime, d) }); } catch (e) { /* optional */ }
  }
  let warmEl = null;
  function prefetchNext(warmAudio) {
    if (!(ep && chIdx + 1 < ep.chapters.length && audioEntry(ep, chIdx + 1))) return;
    fetchChapterJson(ep, chIdx + 1).catch(() => {});
    if (warmAudio) { // start fetching the next MP3 so the hand-over has no gap
      try { warmEl = new Audio(); warmEl.preload = 'auto'; warmEl.src = new URL(audioUrl(ep, chIdx + 1, 'mp3'), location.href).href; } catch (err) { /* optional */ }
    }
  }

  // Hand over to the next chapter inside the 'ended' event itself. When the screen is off or another app is in
  // front, the phone may freeze this page the moment audio stops, so nothing may wait on the network here.
  function fastNext() {
    const n = chIdx + 1;
    if (!settings.autonext || !ep || n >= ep.chapters.length || mode !== 'audio') return false;
    if (!audioEntry(ep, n) || audioFailed.has(ep.id + ':' + n)) return false;
    const data = jsonCache.get(audioUrl(ep, n, 'json'));
    if (!data || data.hash !== ep.chapters[n].hash) return false;
    audioEl.src = new URL(audioUrl(ep, n, 'mp3'), location.href).href;
    audioEl.playbackRate = settings.rate;
    const p = audioEl.play();
    if (p && p.catch) p.catch((err) => { if (!err || err.name !== 'AbortError') { playing = false; setPlayingUi(); unlockScreen(); showToast('Tap play to carry on.'); } });
    loadSeq++; chIdx = n; idx = 0; pendingSeek = null;
    renderChapter({ units: data.units, audio: true });
    mark(0, true); remember(false);
    return true;
  }

  audioEl.addEventListener('loadedmetadata', () => {
    if (pendingSeek !== null) { audioEl.currentTime = pendingSeek; pendingSeek = null; }
    setPosition();
  });
  audioEl.addEventListener('timeupdate', () => {
    if (mode !== 'audio' || !units.length || pendingSeek !== null) return;
    const t = audioEl.currentTime;
    let lo = 0, hi = units.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (units[mid].t <= t + 0.05) lo = mid; else hi = mid - 1; }
    if (lo !== idx) { idx = lo; mark(lo, !audioEl.paused); remember(false); }
    const d = audioEl.duration;
    if (d) {
      $('bar-fill').style.width = Math.round((t / d) * 100) + '%';
      if (t > d * 0.8 && !warmEl) prefetchNext(true);
    }
    if (Date.now() - lastPos > 1000) { lastPos = Date.now(); setPosition(); }
  });
  audioEl.addEventListener('ended', () => { if (mode === 'audio' && !switching && !fastNext()) chapterDone(); });
  audioEl.addEventListener('pause', () => {
    // paused from outside (phone call, headset button, another app took audio focus)
    if (mode === 'audio' && playing && !switching && !audioEl.ended) { playing = false; setPlayingUi(); unlockScreen(); remember(false); }
  });
  audioEl.addEventListener('play', () => {
    if (mode === 'audio' && !playing && !switching) { playing = true; setPlayingUi(); lockScreen(); }
  });
  audioEl.addEventListener('error', () => {
    if (mode !== 'audio' || !ep || !audioEl.getAttribute('src')) return;
    audioFailed.add(ep.id + ':' + chIdx);
    if (naturalOnly(ep)) {
      playing = false; switching = true; try { audioEl.pause(); } catch (e2) { /* optional */ } switching = false;
      setPlayingUi(); unlockScreen();
      showToast('That audio could not load. Check your connection and try again.');
      return;
    }
    showToast('That audio could not load, so this part uses your phone voice.');
    gotoChapter(chIdx, playing, idx);
  });

  /* ---------- rendering the reader ---------- */
  function renderChapter(data) {
    const ch = ep.chapters[chIdx];
    units = data.units;
    mode = data.audio ? 'audio' : 'speech';
    const reader = $('reader');
    reader.textContent = '';
    const h = document.createElement('h2'); h.textContent = ch.label; reader.append(h);
    spans = [];
    let pi = -1, p = null;
    units.forEach((u, i) => {
      if (u.p !== pi) {
        p = document.createElement('p'); reader.append(p); pi = u.p;
        if (u.speaker) {
          const w = document.createElement('span');
          w.className = 'who'; w.textContent = u.speaker;
          p.style.setProperty('--who', SPEAKER_COLORS[Math.max(0, ep.speakers.indexOf(u.speaker)) % SPEAKER_COLORS.length]);
          p.append(w);
        }
      }
      const s = document.createElement('span');
      s.className = 's'; s.dataset.i = String(i); s.textContent = u.text;
      p.append(s, document.createTextNode(' '));
      spans.push(s);
    });
    if (mode === 'audio') {
      const src = new URL(audioUrl(ep, chIdx, 'mp3'), location.href).href;
      if (audioEl.src !== src) audioEl.src = src;
      audioEl.playbackRate = settings.rate;
      warmEl = null; prefetchNext(false);
    } else if (audioEl.getAttribute('src')) {
      audioEl.removeAttribute('src'); audioEl.load();
    }
    $('ch-label').textContent = ch.label;
    $('ch-meta').textContent = `${chIdx + 1} of ${ep.chapters.length} · ${mode === 'audio' ? 'natural voice' : naturalOnly(ep) ? 'audio is being made' : 'phone voice'}`;
    const src = $('sources');
    if (chIdx === ep.chapters.length - 1 && ep.sources.length) {
      src.textContent = '';
      const h3 = document.createElement('h3'); h3.textContent = 'Sources (not read aloud)'; src.append(h3);
      const ul = document.createElement('ul');
      ep.sources.forEach((s) => {
        const li = document.createElement('li'); const a = document.createElement('a');
        a.href = s.url; a.textContent = s.title; a.target = '_blank'; a.rel = 'noopener'; li.append(a); ul.append(li);
      });
      src.append(ul); src.hidden = false;
    } else src.hidden = true;
    updateMedia();
  }

  function mark(i, scroll) {
    spans.forEach((s, j) => {
      s.classList.toggle('active', j === i);
      s.classList.toggle('done', j < i);
    });
    if (!(mode === 'audio' && audioEl.duration)) $('bar-fill').style.width = (units.length ? Math.round((i / units.length) * 100) : 0) + '%';
    if (scroll && spans[i]) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      spans[i].scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }
  }

  function remember(done) {
    if (!ep) return;
    progress[ep.id] = done ? { ch: ep.chapters.length - 1, u: units.length, n: units.length, done: true } : { ch: chIdx, u: idx, n: units.length };
    saveProgress();
  }

  function setPlayingUi() {
    $('ico-play').hidden = playing;
    $('ico-pause').hidden = !playing;
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) { /* optional */ } }
  }

  /* ---------- phone-voice engine (speech synthesis) ---------- */
  function speakUnit(i, my) {
    if (my !== token || !playing) return;
    if (i >= units.length) { chapterDone(); return; }
    idx = i; mark(i, true); remember(false);
    const u = new SpeechSynthesisUtterance(pronounce(units[i].text));
    const sp = units[i].speaker;
    const v = voiceFor(sp);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en';
    u.rate = settings.rate;
    u.pitch = pitchFor(sp, v);
    u.onend = () => { if (my === token && playing) speakUnit(i + 1, my); };
    u.onerror = (e) => {
      if (my !== token) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      playing = false; setPlayingUi(); stopKeepAlive(); unlockScreen();
      showToast('Speech stopped (' + (e.error || 'error') + '). Press play to retry.');
    };
    lastStart = Date.now();
    synth.speak(u);
  }

  function start(i) {
    if (!synth) { showToast('This browser cannot read aloud.'); return; }
    playing = true; setPlayingUi();
    const my = ++token;
    synth.cancel();
    startKeepAlive(); lockScreen(); updateMedia();
    clearInterval(watchdog);
    // Some mobile engines occasionally drop the "end" event; this nudges playback along.
    watchdog = setInterval(() => {
      if (!playing || my !== token) { clearInterval(watchdog); return; }
      if (!synth.speaking && !synth.pending && Date.now() - lastStart > 1500) speakUnit(idx + 1, my);
    }, 2000);
    setTimeout(() => speakUnit(i, my), 60);
  }

  /* ---------- transport: works for both engines ---------- */
  function stopAll() {
    token++; clearInterval(watchdog);
    if (synth) synth.cancel();
    switching = true;
    try { audioEl.pause(); } catch (e) { /* optional */ }
    stopKeepAlive();
  }

  function play() {
    if (!ep) return;
    if (mode === 'audio') {
      playing = true; setPlayingUi(); stopKeepAlive(); lockScreen(); updateMedia();
      switching = false;
      audioEl.playbackRate = settings.rate;
      const p = audioEl.play();
      if (p && p.catch) p.catch((e) => {
        if (e && e.name === 'AbortError') return;
        playing = false; setPlayingUi(); unlockScreen();
        showToast('Tap play to start.');
      });
      return;
    }
    if (naturalOnly(ep)) {
      playing = false; setPlayingUi();
      showToast('Natural audio for this part is still being made, so it is not available yet. Choose "Always use my phone\'s voice" in Settings to listen now.');
      return;
    }
    if (!play.warned) { play.warned = true; showToast('This part uses your phone voice, which stops when you leave the app. Natural audio is still being made for it.'); }
    start(Math.min(idx, Math.max(0, units.length - 1)));
  }

  function pause() {
    playing = false;
    stopAll(); switching = false;
    setPlayingUi(); unlockScreen(); remember(false);
  }
  function toggle() { playing ? pause() : play(); }

  function skip(n) {
    const i = Math.min(Math.max(0, idx + n), Math.max(0, units.length - 1));
    idx = i; mark(i, true); remember(false);
    if (mode === 'audio') seekToUnit(i); else if (playing) start(i);
  }

  function jumpTo(i) {
    idx = i; mark(i, false);
    if (mode === 'audio') { seekToUnit(i); if (!playing) play(); } else start(i);
  }

  async function gotoChapter(n, keepPlaying, at) {
    if (!ep || n < 0 || n >= ep.chapters.length) return;
    const seq = ++loadSeq;
    stopAll();
    chIdx = n; idx = at || 0;
    const data = await loadUnits(ep, n);
    if (seq !== loadSeq) return;
    renderChapter(data);
    idx = Math.min(idx, Math.max(0, units.length - 1));
    if (mode === 'audio') seekToUnit(idx);
    mark(idx, false);
    window.scrollTo({ top: 0 });
    remember(false);
    switching = false;
    if (keepPlaying) play(); else { playing = false; setPlayingUi(); }
  }

  async function chapterDone() {
    if (settings.autonext && chIdx + 1 < ep.chapters.length) { await gotoChapter(chIdx + 1, true); return; }
    const last = chIdx + 1 >= ep.chapters.length;
    playing = false; stopAll(); switching = false; setPlayingUi(); unlockScreen();
    if (last) {
      remember(true);
      const nx = nextInPlaylist();
      if (nx) {
        showToast('Next in your playlist\u2026');
        location.hash = '#/e/' + encodeURIComponent(nx) + '?pl=' + encodeURIComponent(curPl) + '&play=1';
        return;
      }
      showToast('Episode finished.');
    } else await gotoChapter(chIdx + 1, false);
  }

  /* ---------- views and routing ---------- */
  function showLibrary() {
    if (playing) pause();
    ep = null; curPl = null;
    $('view-library').hidden = false; $('view-player').hidden = true; $('view-playlist').hidden = true; $('transport').hidden = true;
    $('back').hidden = true; $('title').textContent = 'Travel Podcasts';
    document.title = 'Travel Podcasts';
    renderLibrary();
    if ('caches' in window) refreshOffline().then(() => { if (!ep) renderLibrary(); });
  }

  function showPlaylist(id) {
    const p = plById(id);
    if (!p) { location.hash = ''; return; }
    if (playing) pause();
    ep = null; curPl = null; tab = 'playlists'; store.set('tp.tab', tab);
    $('view-library').hidden = true; $('view-player').hidden = true; $('transport').hidden = true; $('view-playlist').hidden = false;
    $('back').hidden = false; $('title').textContent = p.name; document.title = p.name + ' \u00b7 Travel Podcasts';
    renderPlaylistView(p);
  }

  async function showEpisode(id, plId, autoplay) {
    const found = library.find((e) => e.id === id);
    if (!found) { location.hash = ''; return; }
    curPl = plId && plById(plId) ? plId : null;
    if (ep && ep.id === id) return;
    if (playing) pause();
    ep = found;
    const pr = progress[ep.id];
    const ch = pr && !pr.done && ep.chapters[pr.ch] ? pr.ch : 0;
    const at = pr && !pr.done ? pr.u || 0 : 0;
    $('view-library').hidden = true; $('view-playlist').hidden = true; $('view-player').hidden = false; $('transport').hidden = false;
    $('back').hidden = false; $('title').textContent = ep.title; document.title = ep.title + ' \u00b7 Travel Podcasts';
    await gotoChapter(ch, false, at);
    if (idx > 0) setTimeout(() => mark(idx, true), 50);
    if (autoplay) play();
  }

  function route() {
    const h = location.hash;
    let m = h.match(/^#\/e\/([^?]+)(?:\?(.*))?$/);
    if (m) {
      const q = new URLSearchParams(m[2] || '');
      showEpisode(decodeURIComponent(m[1]), q.get('pl'), q.get('play') === '1');
      return;
    }
    m = h.match(/^#\/p\/(.+)$/);
    if (m) showPlaylist(decodeURIComponent(m[1])); else showLibrary();
  }

  /* ---------- UI wiring ---------- */
  function buildSpeedButtons() {
    const box = $('speeds'); box.textContent = '';
    SPEEDS.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = r + '×'; b.dataset.rate = String(r);
      b.setAttribute('aria-pressed', String(Math.abs(settings.rate - r) < 0.001));
      b.addEventListener('click', () => {
        settings.rate = r; saveSettings();
        box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        // natural audio changes pace instantly; phone voices apply it from the next sentence
        if (mode === 'audio') audioEl.playbackRate = r;
      });
      box.append(b);
    });
  }

  function openChapterList() {
    const ol = $('ch-list'); ol.textContent = '';
    ep.chapters.forEach((c, i) => {
      const li = document.createElement('li'); const b = document.createElement('button');
      b.type = 'button';
      if (i === chIdx) b.setAttribute('aria-current', 'true');
      const words = c.paragraphs.reduce((m, p) => m + p.split(/\s+/).length, 0);
      const t = document.createElement('span'); t.textContent = c.label;
      const sm = document.createElement('small'); sm.textContent = '~' + Math.max(1, Math.round(words / WPM)) + ' min';
      b.append(t, sm);
      b.addEventListener('click', () => { $('dlg-chapters').close(); gotoChapter(i, playing); });
      li.append(b); ol.append(li);
    });
    $('dlg-chapters').showModal();
  }

  // One voice picker per speaker of the open episode (hidden for single-narrator episodes).
  function renderSpeakerVoices() {
    const box = $('speaker-voices');
    box.textContent = '';
    if (!ep || !ep.speakers || !ep.speakers.length || !voices.length) { box.hidden = true; return; }
    const h = document.createElement('p'); h.className = 'fine'; h.textContent = 'Speakers in this episode';
    box.append(h);
    ep.speakers.forEach((name) => {
      const label = document.createElement('label'); label.className = 'field'; label.textContent = name;
      const sel = document.createElement('select');
      voices.forEach((v) => {
        const o = document.createElement('option'); o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`; sel.append(o);
      });
      const cur = voiceFor(name); if (cur) sel.value = cur.voiceURI;
      sel.addEventListener('change', () => {
        settings.speakerVoices[name] = sel.value; saveSettings();
      });
      label.append(sel); box.append(label);
    });
    box.hidden = false;
  }

  function wire() {
    $('back').addEventListener('click', () => { location.hash = ep && curPl ? '#/p/' + encodeURIComponent(curPl) : ''; });
    document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.tab; store.set('tp.tab', tab); renderLibrary();
    }));
    $('show-hidden').addEventListener('click', () => { showHidden = !showHidden; renderLibrary(); });
    $('pl-new').addEventListener('click', () => askName('New playlist', '', (name) => {
      playlists.push({ id: 'pl-' + Date.now().toString(36), name, items: [] }); savePlaylists(); renderLibrary();
    }));
    $('dlg-pl').addEventListener('close', renderLibrary);
    $('play').addEventListener('click', toggle);
    $('prev-ch').addEventListener('click', () => {
      // like a CD player: first press restarts the chapter, a second press goes back one
      if (idx > 3) gotoChapter(chIdx, playing, 0); else gotoChapter(chIdx - 1, playing);
    });
    $('next-ch').addEventListener('click', () => gotoChapter(chIdx + 1, playing));
    $('back-s').addEventListener('click', () => skip(-3));
    $('fwd-s').addEventListener('click', () => skip(3));
    $('chapters-btn').addEventListener('click', openChapterList);
    $('reader').addEventListener('click', (e) => {
      const s = e.target.closest('.s'); if (!s) return;
      const i = parseInt(s.dataset.i, 10);
      jumpTo(i);
    });
    document.addEventListener('keydown', (e) => {
      if (!ep || e.target.closest('input,textarea,select,dialog')) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.code === 'ArrowRight') skip(3);
      else if (e.code === 'ArrowLeft') skip(-3);
    });

    // settings
    $('settings-btn').addEventListener('click', () => {
      $('engine').value = engine();
      $('wake').checked = !!settings.wake; $('autonext').checked = !!settings.autonext; $('pron').value = settings.pron || '';
      $('gh-token').value = ghToken(); $('gh-status').textContent = ghToken() ? 'Key saved on this phone.' : 'No key saved. Deleting from GitHub is switched off.';
      loadVoices(); renderSpeakerVoices(); $('dlg-settings').showModal();
    });
    $('gh-check').addEventListener('click', () => { store.set('tp.gh', { token: $('gh-token').value.trim() }); checkGh(); });
    $('engine').addEventListener('change', (e) => {
      settings.engine = e.target.value; settings.engineChosen = true; saveSettings();
      if (ep) gotoChapter(chIdx, false, idx); // reload this part with the chosen voice source
    });
    $('voice').addEventListener('change', (e) => { settings.voiceURI = e.target.value; saveSettings(); });
    $('wake').addEventListener('change', (e) => { settings.wake = e.target.checked; saveSettings(); if (!settings.wake) unlockScreen(); else if (playing) lockScreen(); });
    $('autonext').addEventListener('change', (e) => { settings.autonext = e.target.checked; saveSettings(); });
    $('pron').addEventListener('input', (e) => { settings.pron = e.target.value; saveSettings(); });
    $('test-voice').addEventListener('click', () => {
      if (!synth) { showToast('This browser cannot read aloud.'); return; }
      synth.cancel();
      const u = new SpeechSynthesisUtterance('Welcome to Brussels. Over the next hour, we are going to tell the story of a city.');
      const v = currentVoice(); if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = settings.rate; synth.speak(u);
    });
    $('dlg-settings').addEventListener('close', () => { if (synth && !playing) synth.cancel(); });

    // add episode
    $('add-btn').addEventListener('click', () => {
      $('add-err').hidden = true; $('add-title').value = ''; $('add-text').value = ''; $('add-file').value = '';
      $('dlg-add').showModal();
    });
    $('add-file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      $('add-text').value = await f.text();
      if (!$('add-title').value) $('add-title').value = f.name.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ');
    });
    $('add-save').addEventListener('click', () => {
      const err = $('add-err');
      const text = $('add-text').value.trim();
      if (!text) { err.textContent = 'Paste some text or choose a file first.'; err.hidden = false; return; }
      const parsed = parseEpisode(text, $('add-title').value.trim() || 'Untitled episode');
      if ($('add-title').value.trim()) parsed.title = $('add-title').value.trim();
      if (!parsed.chapters.length) { err.textContent = 'Could not find any text to read.'; err.hidden = false; return; }
      delete parsed.notes;
      userEps.push(parsed);
      if (!store.set('tp.user', userEps)) {
        userEps.pop(); err.textContent = 'This phone has no free storage for it.'; err.hidden = false; return;
      }
      $('dlg-add').close();
      loadLibrary().then(() => { renderLibrary(); showToast('Added "' + parsed.title + '".'); });
    });
  }

  /* ---------- start up ---------- */
  async function init() {
    wire(); buildSpeedButtons(); bindMediaKeys();
    if (synth) {
      loadVoices();
      if (synth.addEventListener) synth.addEventListener('voiceschanged', loadVoices);
      else synth.onvoiceschanged = loadVoices;
    } else {
      const n = $('support-note'); n.hidden = false;
      n.textContent = 'This browser cannot read text aloud. Try Chrome on Android or Safari on iPhone.';
    }
    await loadLibrary();
    window.addEventListener('hashchange', route);
    route();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  init();
})();
