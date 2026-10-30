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
    { rate: 1, voiceURI: '', wake: true, autonext: true, follow: false, waitStop: false, pron: '', speakerVoices: {}, engine: 'natural' },
    store.get('tp.settings', {})
  );
  if (settings.engine === 'auto' && !settings.engineChosen) settings.engine = 'natural'; // 'auto' was only ever the old default
  const saveSettings = () => store.set('tp.settings', settings);
  let progress = store.get('tp.progress', {}); // { [episodeId]: { ch, u } }
  const saveProgress = () => store.set('tp.progress', progress);

  /* ---------- episode parsing (same rules as tools/build.py) ---------- */
  const clean = (t) =>
    t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s*\[(?:laugh|chuckle|sigh|cough|gasp|groan|sniff|shush|clear throat)\]/gi, '').replace(/[*_`]+/g, '').replace(/[ \t]+/g, ' ').trim();

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
      format: meta.format || 'deep', series: meta.series || '',
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
    // no lookbehind: older iPhones (before iOS 16.4) cannot even load a script that contains one
    const raw = par.replace(/([.!?]["'”’)\]]?)\s+(?=["'“‘(]?[A-Z0-9À-ſ])/g, '$1\u0001').split('\u0001');
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
      s.replace(/([,;:])\s+/g, '$1\u0001').split('\u0001').forEach((frag) => {
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
    searchIdx = null;
    // first run on this phone: everything already here counts as seen, so only later arrivals are marked New
    if (store.get('tp.seen', null) === null && shipped.length) store.set('tp.seen', shipped.map((x) => x.id));
  }
  const seenSet = () => new Set(store.get('tp.seen', []) || []);
  const isNew = (e) => !e.user && !seenSet().has(e.id);
  function markSeen(id) { const s = seenSet(); if (!s.has(id)) { s.add(id); store.set('tp.seen', [...s]); } }

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
  const haveKeys = () => new Set([...offlineKeys].map((k) => k.replace(/^.*?\/(audio\/)/, '$1')));
  // Downloads every part of one episode into the offline cache (skipping what is already there).
  async function downloadEpisode(e, step) {
    const urls = offlineUrls(e), parts = urls.length / 2;
    const have = haveKeys();
    const cache = await caches.open(AUDIO_CACHE);
    for (let i = 0; i < urls.length; i++) {
      if (step) step(Math.floor(i / 2) + 1, parts);
      if (have.has(urls[i])) continue;
      const r = await fetch(urls[i]);
      if (!r.ok) throw new Error('http ' + r.status);
      await cache.put(urls[i], r);
    }
    // drop older versions of this episode's audio
    const keep = new Set(urls.map((u) => new URL(u, location.href).href));
    const prefix = new URL('audio/' + encodeURIComponent(e.id) + '/', location.href).href;
    for (const req of await cache.keys()) if (req.url.startsWith(prefix) && !keep.has(req.url)) await cache.delete(req);
  }
  // make sure the app itself and the audio list are cached too, so it opens with no signal
  const warmShell = () => Promise.all(['audio/manifest.json', 'library.json'].map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
  async function saveOffline(e, btn) {
    try {
      await warmShell();
      btn.disabled = true;
      await downloadEpisode(e, (i, total) => { btn.textContent = `Saving ${i} of ${total}\u2026`; });
      if (stopsOf(e).length) { btn.textContent = 'Saving the map\u2026'; try { await saveWalkMap(e); } catch (err) { /* the audio is saved; the map can be saved from the walk screen */ } }
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

  /* ---------- audio progress: what is waiting, what is being made now, what is ready ---------- */
  // Read from GitHub's public Actions data (no key needed; a saved key just raises the request limit).
  const audioStatus = { known: false, active: false, runWaiting: false, publishing: false, latestFailed: false, jobs: new Map(), at: 0, sig: '' };
  async function ghGet(path) {
    const headers = { 'Accept': 'application/vnd.github+json' };
    if (ghToken()) headers['Authorization'] = 'Bearer ' + ghToken();
    const res = await fetch(GH_API + path, { headers });
    let data = null;
    try { data = await res.json(); } catch (err) { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  }
  const needsAudio = () => library.some((e) => !e.user && e.chapters.some((_c, n) => !hasAudio(e, n)));

  // ready | finishing (made, being published) | making | waiting | failed | idle (nothing running for it) | unknown
  function chapterState(e, n) {
    if (e.user) return 'ready';
    if (hasAudio(e, n)) return 'ready';
    if (!audioStatus.known) return 'unknown';
    const j = audioStatus.jobs.get(e.id + ':' + n);
    if (j) {
      if (j.status === 'in_progress') return 'making';
      if (j.status === 'queued' || j.status === 'waiting' || j.status === 'pending') return 'waiting';
      if (j.conclusion === 'success') return audioStatus.active ? 'finishing' : 'idle';
      if (j.conclusion === 'failure' || j.conclusion === 'timed_out') return 'failed';
    }
    if (audioStatus.active) return 'waiting';
    return audioStatus.latestFailed ? 'failed' : 'idle';
  }
  const STATE_TEXT = { making: 'being made now', finishing: 'made, publishing', waiting: 'waiting in line', failed: 'hit a problem', idle: 'not started', unknown: 'being made' };

  function episodeAudioSummary(e) {
    const c = { ready: 0, finishing: 0, making: 0, waiting: 0, failed: 0, idle: 0, unknown: 0 };
    e.chapters.forEach((_ch, n) => { c[chapterState(e, n)]++; });
    const total = e.chapters.length, done = c.ready + c.finishing;
    if (c.making) return { kind: 'making', text: `Being made now · ${done} of ${total} parts ready` };
    if (c.waiting) return { kind: 'waiting', text: `Waiting in line · ${done} of ${total} parts ready` };
    if (c.finishing) return { kind: 'making', text: 'Almost ready, publishing…' };
    if (c.failed) return { kind: 'failed', text: `Audio hit a problem · ${done} of ${total} parts ready` };
    if (c.idle) return { kind: 'idle', text: `Audio not started · ${done} of ${total} parts ready` };
    return { kind: 'unknown', text: 'Checking audio…' };
  }
  function statusPill(e) {
    const sm = episodeAudioSummary(e);
    const p = mk('div', 'pill ' + sm.kind, '');
    p.append(mk('span', 'dot', ''), document.createTextNode(sm.text));
    return p;
  }

  function audioSignature() {
    return library.filter((e) => !e.user).map((e) => e.id + ':' + e.chapters.map((_c, n) => chapterState(e, n)[0]).join('')).join('|');
  }

  function renderAudioBanner() {
    const box = $('audio-status');
    if (!audioStatus.known || (!audioStatus.active && !audioStatus.latestFailed && !needsAudio())) { box.hidden = true; return; }
    const all = [];
    library.filter((e) => !e.user).forEach((e) => e.chapters.forEach((_c, n) => { if (!hasAudio(e, n)) all.push(chapterState(e, n)); }));
    const count = (k) => all.filter((x) => x === k).length;
    const making = count('making'), waiting = count('waiting'), failed = count('failed'), finishing = count('finishing');
    const jobs = [...audioStatus.jobs.values()];
    const total = jobs.length, finished = jobs.filter((j) => j.conclusion === 'success').length;
    let kind, title, sub;
    if (audioStatus.active) {
      kind = making || audioStatus.publishing || finishing ? 'making' : 'waiting';
      if (total) {
        title = audioStatus.publishing ? 'Publishing the new audio…' : `Making audio: ${finished} of ${total} parts done`;
        sub = [making && `${making} being made now`, waiting && `${waiting} waiting in line`, failed && `${failed} hit a problem`].filter(Boolean).join(' · ') || 'Almost there';
      } else {
        title = 'Audio job is waiting to start';
        sub = `${all.length} part${all.length === 1 ? '' : 's'} waiting in line`;
      }
      box.dataset.pct = total ? Math.round((finished / total) * 100) : 0;
    } else if (audioStatus.latestFailed || failed) {
      kind = 'failed'; title = 'The last audio job hit a problem'; sub = 'Parts without audio stay unavailable. Ask Claude to look into it.'; box.dataset.pct = 0;
    } else {
      kind = 'idle'; title = 'Some parts have no audio yet'; sub = 'Nothing is running for them. Ask Claude to start it.'; box.dataset.pct = 0;
    }
    box.className = 'audio-status ' + kind;
    $('as-title').textContent = title; $('as-sub').textContent = sub;
    $('as-fill').style.width = box.dataset.pct + '%';
    $('as-bar').hidden = kind === 'idle' || kind === 'failed';
    box.hidden = false;
  }

  function renderAudioStatus() {
    renderAudioBanner();
    const sig = audioSignature();
    if (sig !== audioStatus.sig) {
      audioStatus.sig = sig;
      renderLibrary();
      if (ep && !ep.user && !hasAudio(ep, chIdx)) { const meta = $('ch-meta'); if (meta) meta.textContent = `${chIdx + 1} of ${ep.chapters.length} · audio ${STATE_TEXT[chapterState(ep, chIdx)]}`; }
    }
  }

  // Storage: GitHub Pages and a repository both stay comfortable up to about 1 GB. Audio is the only thing that grows.
  const STORAGE_LIMIT_MB = 1000;
  function renderStorage(host) {
    if (!host) return;
    host.textContent = '';
    const eps = (audioManifest && audioManifest.episodes) || {};
    let bytes = 0, secs = 0;
    Object.values(eps).forEach((e) => Object.values(e.chapters || {}).forEach((c) => { bytes += c.bytes || 0; secs += c.duration || 0; }));
    if (!bytes) { host.append(mk('p', 'fine', 'No audio has been made yet.')); return; }
    const audioMB = bytes / 1048576, hours = secs / 3600;
    const u = audioManifest && audioManifest.usage, repoMB = u && u.repoKB ? u.repoKB / 1024 : null;
    const used = Math.max(audioMB, repoMB || 0), pct = Math.min(100, Math.round((used / STORAGE_LIMIT_MB) * 100));
    const mbPerHour = audioMB / hours, room = Math.max(0, (STORAGE_LIMIT_MB - used) / mbPerHour);
    const mb = (x) => Math.round(x).toLocaleString() + ' MB';
    const meter = mk('div', 'meter ' + (pct >= 85 ? 'high' : pct >= 60 ? 'warn' : ''), '');
    meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', pct + ' percent of the storage limit used');
    const fill = mk('i', '', ''); fill.style.width = Math.max(2, pct) + '%'; meter.append(fill);
    host.append(mk('p', 'stor-head', pct + '% of the storage limit used'), meter);
    host.append(mk('p', 'fine', 'Audio on the site: ' + mb(audioMB) + ' (' + hours.toFixed(1) + ' hours).' + (repoMB ? ' Whole repository, including every older version of the audio: ' + mb(repoMB) + '.' : '') + ' The limit is about ' + mb(STORAGE_LIMIT_MB) + '.'));
    host.append(mk('p', 'fine', pct >= 85 ? 'Nearly full. Ask Claude to tidy the history before making more.' : 'Room for about ' + Math.floor(room) + ' more hours of new audio. Remaking existing audio uses room faster, because GitHub keeps every old version.'));
  }

  function openAudioDetails() {
    const box = $('as-list'); box.textContent = '';
    let shown = 0;
    library.filter((e) => !e.user).forEach((e) => {
      const rows = [];
      e.chapters.forEach((c, n) => { const st = chapterState(e, n); if (st !== 'ready') rows.push({ c, st }); });
      if (!rows.length) return;
      shown++;
      const done = e.chapters.length - rows.length;
      box.append(mk('h3', '', e.title), mk('p', 'fine', done + ' of ' + e.chapters.length + ' parts ready'));
      const ul = mk('ul', 'as-rows', '');
      rows.forEach(({ c, st }) => {
        const li = mk('li', 'as-row ' + st, '');
        li.append(mk('span', 'dot', ''), mk('span', 'as-label', c.label), mk('small', '', STATE_TEXT[st]));
        ul.append(li);
      });
      box.append(ul);
    });
    if (!shown) box.append(mk('p', '', 'Nothing is being made. Every episode is ready.'));
    const when = audioStatus.at ? new Date(audioStatus.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'not yet';
    $('as-updated').textContent = 'Last checked ' + when + '. This page checks again by itself.';
    renderStorage($('as-storage'));
    $('dlg-audio').showModal();
  }

  async function pollAudioStatus() {
    const wasActive = audioStatus.active;
    try {
      const r = await ghGet('/repos/' + GH_REPO + '/actions/workflows/audio.yml/runs?per_page=5');
      if (!r.ok) throw new Error('http ' + r.status);
      const runs = (r.data && r.data.workflow_runs) || [];
      const active = runs.filter((x) => x.status !== 'completed');
      const running = active.find((x) => x.status === 'in_progress');
      audioStatus.active = active.length > 0;
      audioStatus.latestFailed = !!runs[0] && runs[0].status === 'completed' && runs[0].conclusion === 'failure';
      audioStatus.jobs = new Map(); audioStatus.publishing = false;
      if (running) {
        let page = 1, got = 0, totalCount = 0;
        do {
          const jr = await ghGet('/repos/' + GH_REPO + '/actions/runs/' + running.id + '/jobs?per_page=100&page=' + page);
          if (!jr.ok) break;
          totalCount = jr.data.total_count || 0;
          (jr.data.jobs || []).forEach((j) => {
            got++;
            const m = /^synth \((.+?), (\d+)(?:, [a-z0-9-]+)?\)$/.exec(j.name);
            if (m) audioStatus.jobs.set(m[1] + ':' + m[2], { status: j.status, conclusion: j.conclusion });
            else if (j.name === 'publish' && j.status === 'in_progress') audioStatus.publishing = true;
          });
          page++;
        } while (got < totalCount && page < 4);
      }
      audioStatus.known = true; audioStatus.at = Date.now(); audioStatus.failures = 0;
    } catch (err) {
      // offline or rate limited (GitHub allows few anonymous requests): keep what we know for a while, then stop trusting it
      audioStatus.failures = (audioStatus.failures || 0) + 1;
      if (audioStatus.known && Date.now() - audioStatus.at > 10 * 60 * 1000) { audioStatus.known = false; audioStatus.active = false; audioStatus.jobs = new Map(); }
    }
    if (wasActive && !audioStatus.active) audioStatus.fastUntil = Date.now() + 6 * 60 * 1000;
    renderAudioStatus();
  }

  async function refreshLibrary() {
    if (playing) return false;
    const before = ep ? ep.chapters[chIdx] && ep.chapters[chIdx].hash : null;
    await loadLibrary();
    if (ep) {
      const f = library.find((x) => x.id === ep.id);
      if (f) { ep = f; if (ep.chapters[chIdx] && ep.chapters[chIdx].hash !== before) await gotoChapter(chIdx, false, idx); }
    }
    audioStatus.sig = '';
    renderAudioStatus(); renderLibrary();
    return true;
  }

  // The manifest is a plain file, so it can be re-read often and never hits GitHub's request limit.
  async function refreshAudioManifest() {
    try {
      const r = await fetch('audio/manifest.json', { cache: 'no-cache' });
      if (r.ok) audioManifest = await r.json();
    } catch (err) { /* offline: keep the last one */ }
  }

  let audioTimer = null;
  function scheduleAudioPoll(delay) {
    clearTimeout(audioTimer);
    audioTimer = setTimeout(async () => {
      if (document.visibilityState === 'visible') {
        await refreshAudioManifest();
        if (needsAudio()) await pollAudioStatus(); else { audioStatus.active = false; renderAudioStatus(); }
        if (!audioStatus.active && needsAudio()) await refreshLibrary(); // run finished: pick up the new files
      }
      const fast = audioStatus.active || (audioStatus.fastUntil && Date.now() < audioStatus.fastUntil);
      const slow = audioStatus.failures ? 600000 : 300000;
      if (needsAudio() || audioStatus.active) scheduleAudioPoll(fast ? 120000 : slow);
    }, delay);
  }
  function startAudioWatch() {
    if (!needsAudio()) return;
    pollAudioStatus().then(() => scheduleAudioPoll(audioStatus.active ? 120000 : 300000));
  }


  /* ---------- walking map: stops on a street map, with directions. Your position never leaves the phone. ---------- */
  const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const WALK_MIN_PER_M = 1.3 / 80; // streets wind: straight line x 1.3, at about 80 m a minute
  let leafletLoad = null, walkMap = null, walkPins = [], walkWatch = null, walkYou = null, walkSel = 0, walkGps = null;
  const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  function heading(a, b, c, d) {
    const rad = Math.PI / 180, y = Math.sin((d - b) * rad) * Math.cos(c * rad);
    const x = Math.cos(a * rad) * Math.sin(c * rad) - Math.sin(a * rad) * Math.cos(c * rad) * Math.cos((d - b) * rad);
    return DIRS[Math.round((((Math.atan2(y, x) / rad) + 360) % 360) / 45) % 8];
  }
  const walkTime = (m) => Math.max(1, Math.round(m * WALK_MIN_PER_M)) + ' min';
  // Google Maps gets the landmark's name and city, so it routes to the place itself (its entrance), not to a raw coordinate that may sit
  // in the middle of a square or on the wrong side of a canal. The coordinates stay as the fallback when a stop has no name.
  const cleanStopName = (label) => label.replace(/^(stop|chapter)\s*\d+\s*[:.\u2013-]\s*/i, '').split(/,| and /)[0].trim();
  const mapPoint = (st) => (st.q ? encodeURIComponent(st.q) : st.lat + ',' + st.lon);
  const legDirUrl = (a, b) => 'https://www.google.com/maps/dir/?api=1&origin=' + mapPoint(a) + '&destination=' + mapPoint(b) + '&travelmode=walking';
  // "Directions" starts from wherever you are now. Once the phone knows where that is, the button says how far.
  function setDirLabel() {
    const w = walkState(), btn = $('mf-dir'); if (!w || !btn) return;
    const st = w.stops[walkSel];
    btn.textContent = walkGps && st ? 'Directions \u00b7 ' + fmtDist(metres(walkGps.coords.latitude, walkGps.coords.longitude, st.lat, st.lon)) + ' away' : 'Directions';
  }
  function syncHowMore() {
    const p = $('mf-how'), b = $('mf-how-more'); if (!p || !b) return;
    const open = p.classList.contains('open');
    b.hidden = !p.textContent || (!open && p.scrollHeight <= p.clientHeight + 1);
    b.textContent = open ? 'Show less' : 'Read all';
  }
  const dirUrl = (st) => 'https://www.google.com/maps/dir/?api=1&destination=' + mapPoint(st) + '&travelmode=walking';
  function wholeWalkUrl(stops) {
    const f = stops[0], l = stops[stops.length - 1], mid = stops.slice(1, -1).map(mapPoint).join('%7C');
    return 'https://www.google.com/maps/dir/?api=1&origin=' + mapPoint(f) + '&destination=' + mapPoint(l) + (mid ? '&waypoints=' + mid : '') + '&travelmode=walking';
  }
  function legText(stops, k) {
    if (k === 0) return 'First stop';
    const a = stops[k - 1], b = stops[k], m = metres(a.lat, a.lon, b.lat, b.lon);
    return fmtDist(m) + ' ' + heading(a.lat, a.lon, b.lat, b.lon) + ' of stop ' + k + ' · about ' + walkTime(m);
  }
  // Where the player is in the walk: which stop it is on, and which one to walk to next.
  function walkState() {
    const stops = ep ? stopsOf(ep) : [];
    if (!stops.length) return null;
    let cur = stops.findIndex((s) => s.ch === chIdx);
    if (cur < 0) cur = chIdx < stops[0].ch ? -1 : stops.length - 1;
    return { stops, cur, next: cur + 1 < stops.length ? cur + 1 : null };
  }
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletLoad) return leafletLoad;
    leafletLoad = new Promise((resolve, reject) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/leaflet.css'; document.head.append(css);
      const js = document.createElement('script'); js.src = 'vendor/leaflet.js';
      js.onload = () => resolve(window.L); js.onerror = () => { leafletLoad = null; reject(new Error('leaflet')); };
      document.head.append(js);
    });
    return leafletLoad;
  }

  let walkEpId = '', manualSelAt = 0, mapPushed = false, scriptShown = false;
  const walkPref = { gps: () => store.get('tp.walkgps', false) === true, setGps: (v) => store.set('tp.walkgps', v) };

  // The map, the stop buttons and the stop details are one block. It sits in the player page, and moves into the
  // full-screen dialog (and back) so there is only ever one map to keep in step.
  function placeWalkView(where) {
    const v = $('walk-view'), full = where === 'full';
    $(full ? 'walk-slot-full' : 'walk-slot-inline').append(v);
    v.classList.toggle('inline', !full); v.classList.toggle('full', full);
    syncMapTouch();
    refitWalkMap();
  }
  // On a touch screen the small map inside the page lets one finger scroll the page and two fingers move or zoom the map.
  // The full-screen map has no page to scroll, so one finger moves it there.
  const touchScreen = () => !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  function syncMapTouch() {
    if (!walkMap) return;
    if (touchScreen() && $('walk-view').classList.contains('inline')) walkMap.dragging.disable(); else walkMap.dragging.enable();
  }
  let mapHintT = null;
  function wireMapHint(box) {
    const hint = $('map-hint'); if (!hint || box.dataset.hint) return;
    box.dataset.hint = '1';
    box.addEventListener('touchstart', (ev) => {
      if (!touchScreen() || !$('walk-view').classList.contains('inline')) return;
      if (ev.touches.length > 1) { hint.hidden = true; return; }
      hint.hidden = false; clearTimeout(mapHintT); mapHintT = setTimeout(() => { hint.hidden = true; }, 1800);
    }, { passive: true });
    box.addEventListener('touchmove', (ev) => { if (ev.touches.length > 1) hint.hidden = true; }, { passive: true });
  }
  function refitWalkMap() {
    [60, 250].forEach((ms) => setTimeout(() => {
      if (!walkMap || !window.L || $('walk-view').hidden) return;
      walkMap.invalidateSize();
      const w = walkState(); if (w) walkMap.fitBounds(window.L.latLngBounds(w.stops.map((x) => [x.lat, x.lon])), { paddingTopLeft: [40, 56], paddingBottomRight: [40, 36], maxZoom: 17 });
    }, ms));
  }

  function selectStop(k, pan, manual) {
    const w = walkState(); if (!w || !w.stops[k]) return;
    if (manual) manualSelAt = Date.now();
    walkSel = k;
    const st = w.stops[k];
    [...$('walk-chips').children].forEach((bt, i) => bt.setAttribute('aria-current', String(i === k)));
    walkPins.forEach((m, i) => { const el = m.getElement(); if (el) el.classList.toggle('sel', i === k); });
    $('mf-name').textContent = (k + 1) + '. ' + st.name;
    $('mf-leg').textContent = legText(w.stops, k);
    $('mf-how').textContent = st.hint; $('mf-how').classList.remove('open'); setTimeout(syncHowMore, 0);
    $('mf-dir').href = dirUrl(st); setDirLabel();
    const prev = w.stops[k - 1], legA = $('mf-leg-dir');
    legA.hidden = !prev; if (prev) { legA.href = legDirUrl(prev, st); legA.textContent = 'Route from stop ' + k + ' to stop ' + (k + 1); }
    $('mf-play').onclick = () => { closeWalkMap(); gotoChapter(st.ch, true); };
    if (walkGps) showYou(walkGps, true);
    if (pan && walkMap && walkPins[k]) walkMap.panTo(walkPins[k].getLatLng());
  }

  function renderWalkChips(w) {
    const box = $('walk-chips'); box.textContent = '';
    w.stops.forEach((st, k) => {
      const b = mk('button', k === w.next ? 'next' : '', String(k + 1)); b.type = 'button';
      b.setAttribute('aria-label', 'Stop ' + (k + 1) + ': ' + st.name);
      b.addEventListener('click', () => selectStop(k, true, true));
      box.append(b);
    });
    $('map-whole').href = wholeWalkUrl(w.stops);
  }

  async function initWalkMap(w) {
    const box = $('walk-map'); box.classList.remove('offline');
    try {
      const L = await loadLeaflet();
      if (!ep || walkEpId !== ep.id || $('walk-view').hidden) return;
      if (walkMap) { walkMap.remove(); walkMap = null; walkPins = []; walkYou = null; }
      box.textContent = '';
      walkMap = L.map(box, { zoomControl: false, attributionControl: true, tap: true, zoomSnap: 0.25 });
      L.control.zoom({ position: 'bottomleft' }).addTo(walkMap);
      L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(walkMap);
      const pts = w.stops.map((x) => [x.lat, x.lon]);
      L.polyline(pts, { color: '#f0b93b', weight: 4, opacity: .95, dashArray: '2 9', lineCap: 'round' }).addTo(walkMap);
      walkPins = w.stops.map((x, k) => {
        const m = L.marker([x.lat, x.lon], { icon: L.divIcon({ className: 'walk-pin' + (k === w.next ? ' next' : ''), html: '<span>' + (k + 1) + '</span>', iconSize: [34, 34], iconAnchor: [17, 17] }), keyboard: true, title: 'Stop ' + (k + 1) + ': ' + x.name }).addTo(walkMap);
        m.on('click', () => selectStop(k, true, true));
        return m;
      });
      walkMap.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [40, 56], paddingBottomRight: [40, 36], maxZoom: 17 });
      syncMapTouch(); wireMapHint(box);
      refitWalkMap();
      selectStop(walkSel, false);
      if (walkWatch != null && walkGps) showYou(walkGps);
    } catch (err) {
      box.classList.add('offline');
      box.textContent = 'The map needs an internet connection the first time. Directions and the stop details below still work.';
    }
  }

  function setScriptShown(on, remember) {
    scriptShown = on;
    $('reader').hidden = !on;
    $('script-btn').setAttribute('aria-pressed', String(on));
    $('script-label').textContent = on ? 'Hide script' : 'Show script';
    if (remember) store.set('tp.walkscript', on);
    following = true; syncFollowUi(); updateFollowPill();
  }

  // Called whenever the open episode or chapter changes.
  function updateWalkCard() {
    const w = walkState(), wv = $('walk-view');
    $('script-btn').hidden = !w;
    $('view-player').classList.toggle('walk-on', !!w);
    if (!w) {
      wv.hidden = true; $('reader').hidden = false; stopWalkGps(); syncFollowUi(); waitFor = null; arrivePrompt = null; syncArrive();
      if (walkMap) { walkMap.remove(); walkMap = null; walkPins = []; walkYou = null; }
      walkEpId = ''; return;
    }
    $('walk-wait').checked = !!settings.waitStop; syncMapSave();
    if (walkEpId !== ep.id) {
      walkEpId = ep.id; manualSelAt = 0;
      wv.hidden = false;
      setScriptShown(store.get('tp.walkscript', false) === true, false); // the script stays out of the way while walking
      renderWalkChips(w);
      walkSel = w.next != null ? w.next : Math.max(0, w.cur);
      selectStop(walkSel, false);
      initWalkMap(w);
    } else {
      // keep the highlighted "next" stop in step with the chapter, unless you just picked a stop yourself
      [...$('walk-chips').children].forEach((b, i) => b.classList.toggle('next', i === w.next));
      walkPins.forEach((m, i) => { const el = m.getElement(); if (el) el.classList.toggle('next', i === w.next); });
      if (Date.now() - manualSelAt > 60000) selectStop(w.next != null ? w.next : Math.max(0, w.cur), !!walkMap);
    }
    if (walkPref.gps() && walkWatch == null && view === 'player') startWalkGps(true);
    syncArrive();
  }

  function closeWalkMap() { const d = $('dlg-map'); if (d.open) d.close(); }
  function openWalkMap(focus) {
    const w = walkState(); if (!w) return;
    $('map-title').textContent = ep.title.replace(/^Walking\s+/i, '');
    placeWalkView('full');
    $('dlg-map').showModal();
    if (!mapPushed) { history.pushState({ tpMap: 1 }, ''); mapPushed = true; } // the phone's back button closes the map, not the player
    if (focus != null) selectStop(focus, true, true);
  }

  function showYou(pos, noMove) {
    walkGps = pos;
    const L = window.L, w = walkState();
    if (L && walkMap && !noMove) {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      if (!walkYou) walkYou = { dot: L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#2a6c8b', fillOpacity: 1 }).addTo(walkMap), ring: L.circle(ll, { radius: pos.coords.accuracy || 30, color: '#2a6c8b', weight: 1, fillOpacity: .12 }).addTo(walkMap) };
      else { walkYou.dot.setLatLng(ll); walkYou.ring.setLatLng(ll).setRadius(pos.coords.accuracy || 30); }
    }
    setDirLabel();
    const st = w && w.stops[walkSel];
    if (st) {
      const m = metres(pos.coords.latitude, pos.coords.longitude, st.lat, st.lon);
      $('map-gps-note').textContent = m < 40 ? 'You are at stop ' + (walkSel + 1) + '.' : 'You are ' + fmtDist(m) + ' ' + heading(st.lat, st.lon, pos.coords.latitude, pos.coords.longitude) + ' of stop ' + (walkSel + 1) + ' (about ' + walkTime(m) + ' on foot).';
    }
  }
  function setGpsButton(on) { const b = $('map-gps'); b.textContent = on ? 'Hide my location' : 'Show where I am'; b.setAttribute('aria-pressed', String(on)); }
  function startWalkGps(quiet) {
    if (!navigator.geolocation) { if (!quiet) $('map-gps-note').textContent = 'This browser cannot share a location.'; return; }
    setGpsButton(true); if (!quiet) $('map-gps-note').textContent = 'Finding you…';
    walkWatch = navigator.geolocation.watchPosition((pos) => {
      const first = !walkGps; showYou(pos); checkArrival(pos);
      if (first && walkMap && window.L && walkPins[walkSel]) walkMap.fitBounds(window.L.latLngBounds([[pos.coords.latitude, pos.coords.longitude], walkPins[walkSel].getLatLng()]), { paddingTopLeft: [50, 64], paddingBottomRight: [50, 44], maxZoom: 17 });
    }, (err) => {
      if (err.code === 1) { // blocked: stop for good. A lost signal (no fix for a moment) is normal on a walk, so the watch carries on.
        stopWalkGps(); walkPref.setGps(false);
        $('map-gps-note').textContent = 'Location is blocked. Allow it for this site in your browser settings.';
      } else $('map-gps-note').textContent = 'Looking for your location\u2026';
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 60000 });
  }
  function toggleWalkGps() {
    if (walkWatch != null) { stopWalkGps(); walkPref.setGps(false); $('map-gps-note').textContent = ''; return; }
    walkPref.setGps(true); startWalkGps(false);
  }
  function stopWalkGps() {
    if (walkWatch != null && navigator.geolocation) navigator.geolocation.clearWatch(walkWatch);
    walkWatch = null; walkGps = null; setGpsButton(false);
    if (walkYou) { walkYou.dot.remove(); walkYou.ring.remove(); walkYou = null; }
  }

  /* ---------- walk mode: arrival prompt, pausing at each stop, saving the map ---------- */
  // waitFor: the stop whose audio is loaded and paused until you get there. arrivePrompt: a stop you have just reached.
  let waitFor = null, arrivePrompt = null, arrivedHits = 0;
  const arrivedSeen = new Set();
  const holdBefore = (n) => (settings.waitStop && ep ? stopsOf(ep).findIndex((s) => s.ch === n) : -1);
  function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* optional */ } }
  function chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const c = new AC();
      [660, 880].forEach((f, i) => {
        const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + i * 0.18;
        o.frequency.value = f; o.connect(g); g.connect(c.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.start(t); o.stop(t + 0.18);
      });
      setTimeout(() => { try { c.close(); } catch (e) { /* optional */ } }, 800);
    } catch (e) { /* optional */ }
  }
  function waitingStop() {
    if (waitFor == null || playing) return null;
    const w = walkState();
    if (!w || w.cur !== waitFor) { waitFor = null; return null; }
    return waitFor;
  }
  function beginWait(k) { waitFor = k; arrivedHits = 0; arrivePrompt = null; chime(); buzz([150]); syncArrive(); }

  // The one-tap start: only before the walk has begun (still on the welcome part, nothing playing).
  function syncStart() {
    const w = walkState(), box = $('walk-start'); if (!box) return;
    box.hidden = !(w && w.cur < 0 && !playing);
  }
  function startWalk() {
    settings.waitStop = true; settings.wake = true; saveSettings();
    $('walk-wait').checked = true; $('waitstop').checked = true; $('wake').checked = true;
    walkPref.setGps(true); if (walkWatch == null) startWalkGps(false);
    play();
  }
  function syncArrive() {
    syncStart();
    const box = $('walk-arrive'), w = walkState(); if (!box) return;
    const k = waitingStop();
    if (arrivePrompt != null && (!w || w.cur >= arrivePrompt)) arrivePrompt = null;
    $('walk-view').classList.toggle('has-arrive', !!w && (k != null || arrivePrompt != null));
    if (!w || (k == null && arrivePrompt == null)) { box.hidden = true; return; }
    const kk = k != null ? k : arrivePrompt, st = w.stops[kk], go = $('arrive-go'), no = $('arrive-x');
    box.hidden = false;
    if (k != null) {
      let where = '';
      if (walkGps) { const m = metres(walkGps.coords.latitude, walkGps.coords.longitude, st.lat, st.lon); where = m < 45 ? ' You are here.' : ' About ' + fmtDist(m) + ' ' + heading(walkGps.coords.latitude, walkGps.coords.longitude, st.lat, st.lon) + ', ' + walkTime(m) + ' on foot.'; }
      $('arrive-text').textContent = 'Walk to stop ' + (kk + 1) + ', ' + st.name + '.' + where + (walkWatch != null ? ' It starts when you get there.' : ' Tap start when you arrive, or turn on Show where I am and it starts by itself.');
      go.textContent = 'Start stop ' + (kk + 1) + ' now'; no.hidden = true;
    } else {
      $('arrive-text').textContent = 'You have reached stop ' + (kk + 1) + ', ' + st.name + '.';
      go.textContent = 'Play stop ' + (kk + 1); no.hidden = false;
    }
  }
  function checkArrival(pos) {
    const w = walkState(); if (!w) return;
    const waiting = waitingStop(), k = waiting != null ? waiting : w.next;
    if (k == null) { syncArrive(); return; }
    const st = w.stops[k], d = metres(pos.coords.latitude, pos.coords.longitude, st.lat, st.lon);
    const here = d <= Math.max(40, Math.min(pos.coords.accuracy || 0, 60));
    arrivedHits = here ? arrivedHits + 1 : 0; // two fixes in a row, so one stray reading does nothing
    const key = ep.id + ':' + k;
    if (arrivedHits >= 2 && !arrivedSeen.has(key)) {
      arrivedSeen.add(key); chime(); buzz([200, 100, 200]);
      if (waiting != null) { play(); return; }
      arrivePrompt = k;
    }
    syncArrive();
  }
  function arriveGo() {
    const w = walkState(); if (!w) return;
    const k = waitingStop();
    if (k != null) { play(); return; }
    if (arrivePrompt != null) { const st = w.stops[arrivePrompt]; arrivePrompt = null; closeWalkMap(); gotoChapter(st.ch, true); }
  }

  // Map tiles for the whole route, kept for good in their own cache so the map still draws with no signal.
  const MAP_CACHE = 'tp-maps-v1';
  const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const tileY = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
  function routeTiles(stops) {
    const lats = stops.map((s) => s.lat), lons = stops.map((s) => s.lon);
    const mid = (Math.min(...lats) + Math.max(...lats)) / 2, cos = Math.cos((mid * Math.PI) / 180);
    const box = (pad, items) => {
      const dLat = pad / 111320, dLon = pad / (111320 * cos);
      const la = items.map((s) => s.lat), lo = items.map((s) => s.lon);
      return { n: Math.max(...la) + dLat, s: Math.min(...la) - dLat, e: Math.max(...lo) + dLon, w: Math.min(...lo) - dLon };
    };
    const out = [];
    const add = (b, z) => { for (let x = tileX(b.w, z); x <= tileX(b.e, z); x++) for (let y = tileY(b.n, z); y <= tileY(b.s, z); y++) out.push(z + '/' + x + '/' + y); };
    const whole = box(250, stops);
    for (let z = 14; z <= 17; z++) add(whole, z);
    stops.forEach((s) => add(box(120, [s]), 18));
    return [...new Set(out)].slice(0, 220).map((p) => OSM_TILES.replace('{z}/{x}/{y}', p));
  }
  const savedMaps = () => store.get('tp.maps', {});
  async function saveWalkMap(e, onProgress) {
    const stops = stopsOf(e); if (!stops.length || !window.caches) return 0;
    const urls = routeTiles(stops), cache = await caches.open(MAP_CACHE);
    let done = 0, next = 0, failed = 0;
    async function one(url) {
      if (await cache.match(url)) return;
      try {
        let r = await fetch(url, { mode: 'cors' }).catch(() => null);
        if (r && r.ok) { await cache.put(url, r); return; }
        await fetch(url, { mode: 'no-cors' }); // no CORS headers: the service worker keeps it in the general tile cache instead
      } catch (err) { failed++; }
    }
    async function worker() { while (next < urls.length) { const u = urls[next++]; await one(u); done++; if (onProgress) onProgress(done, urls.length); } }
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (failed > urls.length / 2) throw new Error('map download failed');
    const m = savedMaps(); m[e.id] = { n: urls.length, at: Date.now() }; store.set('tp.maps', m);
    return urls.length;
  }
  function syncMapSave() {
    const b = $('map-save'); if (!b || !ep) return;
    const s = savedMaps()[ep.id];
    b.textContent = s ? 'Map saved for offline \u2713 (save again)' : 'Save map for offline';
  }
  async function onSaveMap() {
    const b = $('map-save'), e = ep; if (!e) return;
    b.disabled = true;
    try { const n = await saveWalkMap(e, (i, t) => { b.textContent = 'Saving map ' + i + ' of ' + t + '\u2026'; }); showToast('Map saved. It works without a connection now.'); }
    catch (err) { showToast('Saving the map stopped. Check your connection and try again.'); }
    b.disabled = false; syncMapSave();
  }

  /* ---------- the script and the audio: following is optional ---------- */
  // Off (the default): the highlight moves but the page never does. A button appears when the spoken sentence is out of
  // sight, and tapping it takes you there. On: the page scrolls along, until you scroll away yourself.
  let following = true;
  const hideFollowPill = () => { $('follow-pill').hidden = true; };
  function activeVisible() {
    const el = spans && spans.find((x) => x.classList.contains('active')); if (!el) return true;
    const r = el.getBoundingClientRect(), tr = $('transport').getBoundingClientRect();
    return r.bottom > 60 && r.top < (tr.top || window.innerHeight);
  }
  function updateFollowPill() {
    const scriptOn = view === 'player' && !$('reader').hidden && spans && spans.length;
    $('follow-pill').hidden = !(scriptOn && !(settings.follow && following) && !activeVisible());
  }
  function userScrolled() {
    if (view !== 'player' || $('reader').hidden) return;
    following = false;
    clearTimeout(userScrolled.t);
    userScrolled.t = setTimeout(() => { if (settings.follow && activeVisible()) following = true; updateFollowPill(); }, 700);
  }
  function resumeFollow() {
    following = true; hideFollowPill();
    const el = spans.find((x) => x.classList.contains('active')); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function syncFollowUi() {
    const on = !!settings.follow, btn = $('follow-btn');
    btn.setAttribute('aria-pressed', String(on));
    $('follow-label').textContent = on ? 'Follow audio: on' : 'Follow audio: off';
    btn.hidden = $('reader').hidden;
    const cb = $('follow'); if (cb) cb.checked = on;
  }
  function setFollow(on) {
    settings.follow = on; saveSettings(); following = true; syncFollowUi();
    if (on) resumeFollow(); else updateFollowPill();
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

  /* ---------- formats, versions and covers ---------- */
  const FORMATS = {
    overview: { label: 'Overview', shelf: 'Overviews', sub: 'To prepare for the day' },
    walk: { label: 'Walking tour', shelf: 'Walking tours', sub: 'Listen as you go' },
    deep: { label: 'Deep dive', shelf: 'Deep dives', sub: 'Settle in and learn' },
  };
  const fmtOf = (e) => (FORMATS[e.format] ? e.format : 'deep');
  const variantOf = (e) => (e.speakers && e.speakers.length > 1 ? 'Conversation' : 'Narrated');
  const famKey = (e) => [e.series || e.place || e.id, fmtOf(e), e.chapters.length].join('|');
  // The same topic told two ways (conversation and narrated), with the same chapters: one can be swapped for the other.
  function family(e) {
    if (e.user) return [e];
    const g = library.filter((x) => !x.user && !hidden.includes(x.id) && famKey(x) === famKey(e));
    const labels = g.map(variantOf);
    if (g.length < 2 || !g.includes(e) || new Set(labels).size !== labels.length) return [e];
    return g.slice().sort((a, b) => (variantOf(a) === 'Conversation' ? 0 : 1) - (variantOf(b) === 'Conversation' ? 0 : 1));
  }
  const isPrimary = (e) => family(e)[0] === e;

  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) {
    return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const COVERS = [['#12404f', '#1d6177'], ['#4a2234', '#74344d'], ['#26402f', '#3f6a4e'], ['#2b2f5e', '#474d92'], ['#5a3418', '#8a5428'], ['#233a56', '#385f8c']];
  const CREAM = '#f2ead2', SIGNAL = '#f0b93b';
  // Covers are small illustrations of the place itself: a skyline of its landmarks, with the kind of episode in the foreground.
  //   overview: the sun coming up behind the skyline.   walk: a footpath toward it, one stop per chapter.
  //   deep dive: layers of history under it, one per chapter.   Dots show how far you have listened.
  const INK = '#06131a';
  const r1 = (v) => Math.round(v * 10) / 10;
  const shade = (hex, k) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('');
  function gabled(x, w, top, step, lit) {
    const cx = w / 2, pts = [[x, 68], [x, top]];
    for (let k = 0; k < 3; k++) { const s = (w / 2 - 1) * (k / 2.4); pts.push([x + s, top - k * step]); pts.push([x + s + 1.4, top - k * step]); pts.push([x + s + 1.4, top - (k + 1) * step]); }
    // mirror the steps down the other side
    const left = pts.slice(2);
    const right = left.map(([px, py]) => [x + w - (px - x), py]).reverse();
    return `<polygon points="${[...pts, ...right, [x + w, 68]].map((p) => p.map(r1).join(',')).join(' ')}"/>` +
      (lit ? `<rect x="${r1(x + cx - 0.9)}" y="${r1(top + 3)}" width="1.8" height="2.2" fill="${SIGNAL}" opacity=".85" stroke="none"/>` : '');
  }
  function houses(x0, x1, rnd, minH, maxH) {
    let out = '', x = x0;
    while (x < x1 - 7) { const w = 7 + Math.floor(rnd() * 4); out += gabled(x, w, 68 - (minH + rnd() * (maxH - minH)), 2.2, rnd() > 0.45); x += w + 0.6; }
    return out;
  }
  function spire(cx, base, top, w) { return `<polygon points="${r1(cx - w)},${base} ${r1(cx)},${top} ${r1(cx + w)},${base}"/>`; }
  function motif(place, rnd) {
    const pl = fold(place || '');
    if (pl.includes('brussel') || pl.includes('bruxelles')) {
      // guild houses, the town hall with its spire, the Atomium
      const sph = [[82, 21], [73, 31], [91, 31], [82, 40], [73, 49], [91, 49], [82, 60]];
      const tubes = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [3, 5], [4, 6], [5, 6], [1, 4], [2, 5], [6, 6]];
      let a = houses(0, 41, rnd, 12, 22);
      a += `<rect x="42" y="46" width="19" height="22"/><rect x="48.5" y="28" width="5" height="19"/><rect x="47.3" y="22" width="7.4" height="7"/>${spire(51, 22, 3, 3.8)}<rect x="50.6" y="1" width=".8" height="3"/>`;
      a += `<rect x="45" y="42" width="3" height="5"/><rect x="55" y="42" width="3" height="5"/>`;
      a += `<g fill="none" stroke="${INK}" stroke-width="1.5">${tubes.map(([i, j]) => `<line x1="${sph[i][0]}" y1="${sph[i][1]}" x2="${sph[j][0]}" y2="${j === i ? 68 : sph[j][1]}"/>`).join('')}</g>`;
      a += sph.map(([sx, sy]) => `<circle cx="${sx}" cy="${sy}" r="4.3"/>`).join('');
      a += `<rect x="80.6" y="58" width="2.8" height="10"/>`;
      return a;
    }
    if (pl.includes('luxembourg')) {
      // the cliff and casemates, the Adolphe Bridge, the cathedral spires
      let a = `<polygon points="0,68 0,36 6,34 9,38 14,35 17,41 23,40 26,47 32,52 38,68"/>`;
      for (let k = 0; k < 5; k++) a += `<rect x="${1 + k * 3.4}" y="${31.5 + (k % 2) * 0.4}" width="2" height="3"/>`;
      a += `<rect x="3" y="24" width="5" height="11"/>${spire(5.5, 24, 15, 3.4)}`;
      a += `<path d="M38,68 Q59,30 80,68 L74.5,68 Q59,41 43.5,68Z"/><rect x="34" y="43.5" width="51" height="3.2"/>`;
      a += `<rect x="46" y="46.5" width="2" height="8"/><rect x="58" y="46.5" width="2" height="4"/><rect x="70" y="46.5" width="2" height="8"/>`;
      a += `<polygon points="82,68 82,40 100,38 100,68"/>${spire(88, 40, 14, 2.2)}${spire(94.5, 38, 22, 2)}<rect x="86" y="40" width="4.2" height="8"/>`;
      a += `<rect x="84.6" y="52" width="1.8" height="2.4" fill="${SIGNAL}" opacity=".85" stroke="none"/><rect x="92" y="55" width="1.8" height="2.4" fill="${SIGNAL}" opacity=".85" stroke="none"/>`;
      return a;
    }
    if (pl.includes('brugge') || pl.includes('bruges')) {
      // the belfry among gabled houses
      let a = houses(0, 43, rnd, 12, 20) + houses(58, 100, rnd, 12, 20);
      a += `<rect x="44" y="26" width="13" height="42"/>`;
      for (let k = 0; k < 4; k++) a += `<rect x="${44 + k * 3.6}" y="23.5" width="2.2" height="3"/>`;
      a += `<rect x="46.2" y="12" width="8.6" height="12"/>${spire(50.5, 12, 3, 4.6)}<rect x="50.1" y="0" width=".8" height="3.4"/>`;
      a += `<rect x="49" y="31" width="3" height="5" fill="${SIGNAL}" opacity=".85" stroke="none"/><rect x="49" y="42" width="3" height="5" fill="${SIGNAL}" opacity=".85" stroke="none"/>`;
      return a;
    }
    // any other old town: gabled houses and a church spire
    const sx = 55 + rnd() * 20;
    return houses(0, sx - 6, rnd, 12, 22) + houses(sx + 8, 100, rnd, 12, 22) +
      `<rect x="${r1(sx - 5)}" y="38" width="10" height="30"/><rect x="${r1(sx - 3)}" y="28" width="6" height="11"/>${spire(sx, 28, 6, 3.6)}<rect x="${r1(sx - 0.4)}" y="3" width=".8" height="4"/>`;
  }
  function coverSvg(e) {
    const rnd = rng(hashStr(e.id));
    const [bg, hi] = COVERS[hashStr(e.place || e.series || e.id) % COVERS.length];
    const f = fmtOf(e);
    const n = Math.min(Math.max(e.chapters.length, 2), 14);
    const pr = progress[e.id];
    const heard = pr ? (pr.done ? n : Math.min(pr.ch, n)) : 0;
    const cur = pr && !pr.done ? Math.min(pr.ch, n - 1) : -1;
    const dot = (x, y, i, s) => i < heard ? `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(2.6 * s)}" fill="${SIGNAL}"/>`
      : i === cur ? `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(3 * s)}" fill="${bg}" stroke="${SIGNAL}" stroke-width="${r1(1.6 * s)}"/>`
        : `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(2.3 * s)}" fill="${bg}" stroke="${CREAM}" stroke-width="${r1(1.1 * s)}"/>`;
    let out = `<rect width="100" height="100" fill="${bg}"/>`;
    if (f === 'overview') {
      const cx = 22 + rnd() * 56;
      out += `<circle cx="${r1(cx)}" cy="64" r="30" fill="${SIGNAL}" opacity=".16"/><circle cx="${r1(cx)}" cy="64" r="21" fill="${SIGNAL}" opacity=".22"/><circle cx="${r1(cx)}" cy="64" r="13" fill="${SIGNAL}"/>`;
    }
    const sil = shade(bg, 0.4);
    out += `<g fill="${sil}" stroke="${sil}" stroke-width=".2">${motif(e.place, rnd).split(INK).join(sil)}</g>`;
    if (f === 'deep') {
      const k = Math.min(Math.max(n, 3), 8), th = 32 / k;
      for (let i = 0; i < k; i++) out += `<rect x="0" y="${r1(68 + i * th)}" width="100" height="${r1(th + 0.2)}" fill="${shade(hi, (i % 2 ? 0.8 : 1) - 0.07 * i)}"/><path d="M0,${r1(68 + i * th)}H100" stroke="${CREAM}" stroke-width=".5" opacity=".28"/>`;
    } else {
      out += `<rect x="0" y="68" width="100" height="32" fill="${hi}"/><path d="M0,68H100" stroke="${CREAM}" stroke-width=".6" opacity=".4"/>`;
    }
    if (f === 'walk') {
      const P = [[22, 99], [-4, 86], [76, 84], [57, 69.5]];
      const at = (t) => { const u = 1 - t; return [0, 1].map((k) => u * u * u * P[0][k] + 3 * u * u * t * P[1][k] + 3 * u * t * t * P[2][k] + t * t * t * P[3][k]); };
      out += `<path d="M${P[0]} C${P[1]} ${P[2]} ${P[3]}" fill="none" stroke="${CREAM}" stroke-width="7" stroke-linecap="round" opacity=".22"/><path d="M${P[0]} C${P[1]} ${P[2]} ${P[3]}" fill="none" stroke="${CREAM}" stroke-width="1.1" stroke-linecap="round" stroke-dasharray="0.1 2.6" opacity=".9"/>`;
      for (let i = 0; i < n; i++) { const [x, y] = at(0.06 + (0.88 * i) / (n - 1)); out += dot(x, y, i, 0.55 + 0.5 * ((y - 69) / 30)); }
    } else {
      const w = n * 5.4 + 5, x0 = 50 - w / 2;
      out += `<rect x="${r1(x0)}" y="88" width="${r1(w)}" height="8" rx="4" fill="${INK}" opacity=".5"/>`;
      for (let i = 0; i < n; i++) out += dot(x0 + 4.3 + i * 5.4, 92, i, 0.72);
    }
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${out}</svg>`;
  }
  function coverEl(e) { const c = mk('span', 'cover', ''); c.innerHTML = coverSvg(e); return c; }

  function audioBadge(e) {
    if (e.user) return null;
    const total = e.chapters.length, ac = audioCount(e);
    if (ac >= total) return null;
    const sm = episodeAudioSummary(e);
    const text = { making: `Making ${ac}/${total}`, waiting: 'In line', failed: 'Problem', idle: 'Not started', unknown: 'Audio coming' }[sm.kind] || 'Audio coming';
    const b = mk('span', 'badge ' + sm.kind, '');
    b.append(mk('span', 'dot', ''), document.createTextNode(text));
    return b;
  }

  /* ---------- lists: Home, Library ---------- */
  function renderPlaceChips(box, places, again) {
    box.textContent = '';
    box.hidden = places.length < 2;
    if (placeFilter && !places.includes(placeFilter)) placeFilter = '';
    ['', ...places].forEach((pl) => {
      const b = mk('button', 'chip-btn', pl || 'All');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(placeFilter === pl));
      b.addEventListener('click', () => { placeFilter = pl; renderLibrary(); });
      box.append(b);
    });
  }

  function buildTile(e, note) {
    const li = mk('li', 'tile');
    const b = mk('button', '', '');
    b.type = 'button';
    const wrap = mk('span', 'cover-wrap', '');
    wrap.append(coverEl(e));
    const badge = audioBadge(e); if (badge) wrap.append(badge);
    if (isNew(e)) wrap.append(mk('span', 'badge-new', 'New'));
    const fam = family(e);
    b.append(wrap, mk('span', 't-title', e.title), mk('span', 't-meta', `${e.minutes} min · ${variantOf(e)}${fam.length > 1 ? ' · 2 versions' : ''}${savedOffline(e) ? ' · saved' : ''}${note ? ' · ' + note : ''}`));
    b.addEventListener('click', () => { location.hash = '#/e/' + encodeURIComponent(e.id); });
    li.append(b);
    return li;
  }

  /* ---------- near you: uses the phone's location, only on the phone; nothing is sent anywhere ---------- */
  const PLACES = { brussels: [50.8467, 4.3525], luxembourg: [49.6116, 6.1319], bruges: [51.2093, 3.2247], ghent: [51.0543, 3.7174], antwerp: [51.2194, 4.4025] };
  const GEO_STOPS = { 'brussels-walk-lower-town': [[50.84497, 4.34992], [50.84673, 4.35247], [50.84836, 4.35519], [50.84812, 4.35003], [50.84877, 4.34701]] };
  let here = null, nearErr = '', locating = false;
  const nearOn = () => store.get('tp.near', false) === true;
  const placeCentre = (e) => (e.lat != null && e.lon != null ? [+e.lat, +e.lon] : PLACES[fold(e.place || '')] || null);
  function stopsOf(e) {
    const pts = e.stops && e.stops.length ? e.stops : GEO_STOPS[e.id];
    if (!pts) return [];
    const chs = e.chapters.map((c, i) => (/^(stop|chapter)\s*\d+/i.test(c.label) ? i : -1)).filter((i) => i >= 0);
    return pts.slice(0, chs.length).map((pt, k) => ({
      lat: pt[0], lon: pt[1], ch: chs[k], k,
      name: e.chapters[chs[k]].label.replace(/^(stop|chapter)\s*\d+\s*[:.\u2013-]\s*/i, ''),
      hint: (e.hints && e.hints[k]) || '',
      q: ((e.maps && e.maps[k]) || (e.place ? cleanStopName(e.chapters[chs[k]].label) + ', ' + e.place : '')).trim(),
    }));
  }
  function metres(a, b, c, d) {
    const R = 6371000, rad = Math.PI / 180, dLat = (c - a) * rad, dLon = (d - b) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const fmtDist = (m) => (m < 950 ? Math.max(10, Math.round(m / 10) * 10) + ' m' : m < 10000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m / 1000) + ' km');
  function locate() {
    locating = true;
    return new Promise((resolve) => {
      if (!navigator.geolocation) { nearErr = 'unavailable'; locating = false; resolve(); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        here = { lat: pos.coords.latitude, lon: pos.coords.longitude, at: Date.now() }; nearErr = ''; locating = false; resolve();
      }, (err) => {
        nearErr = err && err.code === 1 ? 'blocked' : 'unavailable'; locating = false; resolve();
      }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 120000 });
    });
  }
  function renderNear(box) {
    const sec = mk('section', 'shelf near', '');
    box.append(sec);
    sec.append(mk('h2', '', 'Near you'));
    const retry = (label) => { const b = mk('button', 'ghost small', label); b.type = 'button'; b.addEventListener('click', () => { nearErr = ''; store.set('tp.near', true); locate().then(renderLibrary); renderLibrary(); }); sec.append(b); };
    if (!nearOn()) {
      sec.append(mk('p', 'sub', 'Finds episodes for the place you are in, and the tour stop you are standing at. Your location stays on this phone.'));
      retry('Use my location');
      return;
    }
    if (nearErr) {
      sec.append(mk('p', 'sub', nearErr === 'blocked' ? 'Location is blocked for this app. Allow it in Chrome\u2019s site settings, then try again.' : 'Could not find your location. Check that location is on, then try again.'));
      retry('Try again');
      return;
    }
    if (!here || Date.now() - here.at > 120000) {
      sec.append(mk('p', 'sub', here ? 'Updating\u2026' : 'Finding where you are\u2026'));
      if (!locating) locate().then(renderLibrary);
      if (!here) return;
    }
    const eps = library.filter((x) => !hidden.includes(x.id) && isPrimary(x));
    // 1. a tour stop within walking distance
    const stops = [];
    eps.forEach((x) => stopsOf(x).forEach((st, k) => { const d = metres(here.lat, here.lon, st.lat, st.lon); if (d < 300) stops.push({ e: x, st, k, d }); }));
    stops.sort((a, b) => a.d - b.d);
    if (stops.length) {
      sec.append(mk('p', 'sub', 'You are close to a stop on a walking tour.'));
      const list = mk('div', 'cont', '');
      stops.slice(0, 2).forEach(({ e: x, st, k, d }) => {
        const c = mk('button', 'cont-card', ''); c.type = 'button';
        const t = mk('span', '', '');
        t.append(mk('span', 'c-title', x.chapters[st.ch].label), mk('div', 'c-sub', `${x.title} \u00b7 ${fmtDist(d)} away \u00b7 Listen from here`));
        c.append(coverEl(x), t);
        c.addEventListener('click', () => { location.hash = '#/e/' + encodeURIComponent(x.id) + '?ch=' + st.ch + '&play=1'; });
        list.append(c);
      });
      sec.append(list);
    }
    // 2. episodes for the place you are in
    const dist = eps.map((x) => { const c = placeCentre(x); return c ? { e: x, d: metres(here.lat, here.lon, c[0], c[1]) } : null; }).filter(Boolean).sort((a, b) => a.d - b.d);
    const close = dist.filter((x) => x.d < 40000);
    if (close.length) {
      if (!stops.length) sec.append(mk('p', 'sub', 'About ' + fmtDist(close[0].d) + ' from the centre of ' + close[0].e.place + '.'));
      const ul = mk('ul', 'tiles', '');
      close.forEach(({ e: x }) => ul.append(buildTile(x)));
      sec.append(ul);
    } else if (!stops.length) {
      sec.append(mk('p', 'sub', dist.length ? `Nothing for where you are yet. The closest is ${dist[0].e.place}, ${fmtDist(dist[0].d)} away. Ask for one in the Create tab.` : 'No episode has a location yet.'));
    }
    const off = mk('button', 'linkish', 'Turn off location'); off.type = 'button';
    off.addEventListener('click', () => { store.set('tp.near', false); here = null; renderLibrary(); });
    sec.append(off);
  }


  /* ---------- trip packs: everything for one place, saved to the phone in one tap ---------- */
  const packBusy = new Map(); // place -> progress text while saving
  function epBytes(e) {
    const m = audioManifest && audioManifest.episodes && audioManifest.episodes[e.id];
    return m ? Object.values(m.chapters || {}).reduce((n, c) => n + (c.bytes || 0), 0) : 0;
  }
  function tripPacks(list) {
    const by = new Map();
    list.filter((x) => x.place && offlineUrls(x).length).forEach((x) => { if (!by.has(x.place)) by.set(x.place, []); by.get(x.place).push(x); });
    return [...by].map(([place, eps]) => {
      const todo = eps.filter((x) => !savedOffline(x));
      return { place, eps, todo, mb: todo.reduce((n, x) => n + epBytes(x), 0) / 1048576 };
    }).sort((a, b) => (b.todo.length > 0) - (a.todo.length > 0) || a.place.localeCompare(b.place));
  }
  async function savePack(p) {
    if (packBusy.has(p.place)) return;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const s = await navigator.storage.estimate();
        if (s.quota && s.quota - s.usage < p.mb * 1048576 * 1.3 + 30e6 && !confirm('This phone is getting short of space (about ' + Math.round((s.quota - s.usage) / 1048576) + ' MB free). Save anyway?')) return;
      }
      await warmShell();
      for (let i = 0; i < p.todo.length; i++) {
        const e = p.todo[i];
        packBusy.set(p.place, `Saving ${i + 1} of ${p.todo.length}\u2026`); renderLibrary();
        await downloadEpisode(e);
        if (stopsOf(e).length) { try { await saveWalkMap(e); } catch (err) { /* audio is saved; the map can be saved from the walk screen */ } }
        await refreshOffline();
      }
      showToast(p.place + ' is saved. It will play with no signal.');
    } catch (err) { showToast('Saving stopped. Check your connection and tap again; nothing is lost.'); }
    packBusy.delete(p.place); await refreshOffline(); renderLibrary();
  }
  // Location permission, as far as this browser will tell us. Safari cannot always say, so "unknown" is a real state.
  let geoPerm = 'unknown';
  try {
    if (navigator.permissions && navigator.permissions.query) navigator.permissions.query({ name: 'geolocation' }).then((s) => {
      geoPerm = s.state; s.onchange = () => { geoPerm = s.state; if (view === 'home') renderLibrary(); };
    }).catch(() => {});
  } catch (e) { /* optional */ }
  function askLocation() {
    if (!navigator.geolocation) { showToast('This browser cannot share a location.'); return; }
    navigator.geolocation.getCurrentPosition(() => { geoPerm = 'granted'; renderLibrary(); showToast('Location is on.'); }, (err) => {
      if (err.code === 1) { geoPerm = 'denied'; showToast('Location is blocked. Allow it for this site in your phone\u2019s browser settings.'); }
      else showToast('Could not find you just now. Try again outside.');
      renderLibrary();
    }, { timeout: 20000, maximumAge: 60000 });
  }
  async function savePackMaps(p) {
    if (packBusy.has(p.place)) return;
    try {
      for (const e of p.eps.filter((x) => stopsOf(x).length && !savedMaps()[x.id])) { packBusy.set(p.place, 'Saving maps\u2026'); renderLibrary(); await saveWalkMap(e); }
      showToast('Walking maps for ' + p.place + ' are saved.');
    } catch (err) { showToast('Saving the maps stopped. Check your connection and try again.'); }
    packBusy.delete(p.place); renderLibrary();
  }
  function packChecks(p) {
    const walks = p.eps.filter((x) => stopsOf(x).length);
    const row = mk('div', 'pack-check', '');
    const item = (ok, text, fix, fixLabel) => {
      const s = mk('span', 'pc ' + (ok ? 'ok' : 'todo'), '');
      s.append(mk('span', 'pc-i', ok ? '\u2713' : '\u2717'), document.createTextNode(' ' + text));
      if (!ok && fix) { const b = mk('button', 'pc-fix', fixLabel); b.type = 'button'; b.disabled = !online() && fixLabel !== 'Allow'; b.addEventListener('click', fix); s.append(b); }
      row.append(s);
    };
    item(!p.todo.length, 'Audio', () => savePack(p), 'Save');
    if (walks.length) {
      item(walks.every((x) => savedMaps()[x.id]), 'Maps', () => savePackMaps(p), 'Save');
      item(geoPerm === 'granted', 'Location', askLocation, 'Allow');
    }
    return row;
  }
  function renderPacks(box, list) {
    const packs = tripPacks(list).filter((p) => !placeFilter || p.place === placeFilter).slice(0, placeFilter ? 1 : 4);
    if (!packs.length) return;
    const sec = mk('section', 'shelf packs', '');
    sec.append(mk('h2', '', 'Get ready for a trip'), mk('p', 'sub', 'Saves every episode and the walking maps for a place, so they work with no signal.'));
    packs.forEach((p) => {
      const row = mk('div', 'pack', ''), top = mk('div', 'pack-top', ''), t = mk('span', 'pack-t', '');
      const busy = packBusy.get(p.place);
      t.append(mk('span', 'pack-n', p.place), mk('small', '', `${p.eps.length} episode${p.eps.length > 1 ? 's' : ''} \u00b7 ` + (p.todo.length ? `about ${Math.max(1, Math.round(p.mb))} MB to save` : 'all saved on this phone')));
      const b = mk('button', p.todo.length ? 'btn-sm' : 'btn-sm ghost', busy || (p.todo.length ? (online() ? 'Save for the trip' : 'Needs a connection') : 'Saved'));
      b.type = 'button'; b.disabled = !!busy || !p.todo.length || !online();
      b.addEventListener('click', () => savePack(p));
      top.append(t, b); row.append(top, packChecks(p)); sec.append(row);
    });
    box.append(sec);
  }

  /* ---------- connection: a banner when offline, and the outbox goes out when it comes back ---------- */
  const online = () => navigator.onLine !== false;
  function syncOnline() {
    const bar = $('offline-bar'); if (bar) bar.hidden = online();
    if (view === 'create') syncCreateForm();
    if (view === 'home' || view === 'library') renderLibrary();
    if (online()) flushOutbox();
  }

  /* ---------- first-run welcome: three things worth knowing, shown once ---------- */
  function renderWelcome(box) {
    if (store.get('tp.welcomed', false)) return;
    const installed = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    const sec = mk('section', 'welcome', '');
    sec.append(mk('h2', '', 'Welcome'));
    const ul = mk('ul', '', '');
    const li = (head, text) => { const l = mk('li', ''); l.append(mk('strong', '', head + ' '), document.createTextNode(text)); ul.append(l); };
    if (!installed) li('Put it on your home screen.', 'On iPhone, tap Share in Safari, then Add to Home Screen. In Chrome on Android, open the menu and choose Add to Home screen. It then opens like any other app.');
    li('Ask for what you need.', 'The Create tab sends a request for an overview, a walking tour or a deep dive. It is written and voiced within a few hours.');
    li('Save before you leave Wi-Fi.', 'Under Get ready for a trip, tap Save for the trip. Everything for that place then plays with no signal, maps included.');
    sec.append(ul);
    const ok = mk('button', 'btn-sm', 'Got it'); ok.type = 'button';
    ok.addEventListener('click', () => { store.set('tp.welcomed', true); renderLibrary(); });
    sec.append(ok);
    box.append(sec);
  }

  /* ---------- Home: what has been asked for and is not finished yet ---------- */
  let reqTried = 0;
  function renderOnItsWay(box) {
    if (!relayReady() && !outbox().length) return;
    const cache = store.get('tp.requests', null);
    if (relayReady() && online() && Date.now() - reqTried > 120000 && (!cache || Date.now() - cache.at > 120000)) { reqTried = Date.now(); loadRequests(); }
    const queued = outbox().map((x) => ({ title: x.title, state: 'queued' }));
    const open = ((cache && cache.items) || []).filter((x) => x.state === 'open' && !queued.some((q) => q.title === x.title.replace(/^Episode request:\s*/i, '')));
    const all = queued.concat(open);
    if (!all.length) return;
    const sec = mk('section', 'shelf inworks', '');
    sec.append(mk('h2', '', 'On its way'));
    all.forEach((x) => {
      const row = mk('div', 'iw', '');
      row.append(mk('span', 'iw-t', x.title.replace(/^Episode request:\s*/i, '')));
      const eta = mk('span', 'rq-eta', etaText(x.state)); eta.dataset.eta = x.state; row.append(eta);
      sec.append(row);
    });
    const more = mk('button', 'linkish', 'See all requests'); more.type = 'button';
    more.addEventListener('click', () => { location.hash = '#/create'; });
    sec.append(more);
    box.append(sec);
  }

  function renderHome() {
    const visible = library.filter((x) => !hidden.includes(x.id));
    renderPlaceChips($('home-places'), [...new Set(visible.map((x) => x.place).filter(Boolean))]);
    const box = $('home-shelves');
    box.textContent = '';
    const shown = visible.filter((x) => !placeFilter || x.place === placeFilter);
    if (!shown.length) {
      const em = mk('div', 'empty', '');
      em.append(mk('h2', '', library.length ? 'Nothing here yet' : 'No episodes yet'), mk('p', '', 'Ask for one in the Create tab, or add a script you already have in Library.'));
      box.append(em);
      return;
    }
    renderWelcome(box);
    renderOnItsWay(box);
    renderNear(box);
    renderPacks(box, visible);
    const shelf = (title, sub) => { const s = mk('section', 'shelf', ''); s.append(mk('h2', '', title)); if (sub) s.append(mk('p', 'sub', sub)); box.append(s); return s; };
    const cont = shown.filter((x) => { const p = percent(x); return p > 0 && p < 100; })
      .sort((a, b) => ((progress[b.id] || {}).t || 0) - ((progress[a.id] || {}).t || 0)).slice(0, 3);
    if (cont.length) {
      const s = shelf('Pick up where you left off');
      const list = mk('div', 'cont', '');
      cont.forEach((x) => {
        const pr = progress[x.id];
        const c = mk('button', 'cont-card', ''); c.type = 'button';
        const t = mk('span', '', '');
        const ch = x.chapters[pr.ch];
        t.append(mk('span', 'c-title', x.title), mk('div', 'c-sub', `${ch ? ch.label : ''} · ${percent(x)}% heard`));
        const bar = mk('div', 'progress', ''); const fill = document.createElement('div'); fill.style.width = percent(x) + '%'; bar.append(fill); t.append(bar);
        c.append(coverEl(x), t);
        c.addEventListener('click', () => { location.hash = '#/e/' + encodeURIComponent(x.id); });
        list.append(c);
      });
      s.append(list);
    }
    ['overview', 'walk', 'deep'].forEach((f) => {
      const items = shown.filter((x) => fmtOf(x) === f && isPrimary(x));
      if (!items.length) return;
      const s = shelf(FORMATS[f].shelf, FORMATS[f].sub);
      const ul = mk('ul', 'tiles', '');
      items.forEach((x) => ul.append(buildTile(x)));
      s.append(ul);
    });
  }

  function buildCard(e, removed) {
    const li = mk('li', 'card' + (removed ? ' removed' : ''));
    const body = mk('div', 'card-body');
    li.append(coverEl(e), body);
    const pct = percent(e);
    const nowPlaying = !removed && ep && ep.id === e.id;
    const where = [e.place || (e.user ? 'Added by you' : 'Episode'), FORMATS[fmtOf(e)].label, variantOf(e)].join(' · ');
    body.append(mk('span', 'place', removed ? 'Removed' : (isNew(e) ? 'NEW \u00b7 ' : '') + where + (nowPlaying ? ' · now ' + (playing ? 'playing' : 'open') : '')));
    body.append(mk('h2', '', e.title));
    if (e.blurb) body.append(mk('p', '', e.blurb));
    const ac = audioCount(e);
    const audioNote = ac === e.chapters.length ? ' · natural voice' : ac ? ` · natural voice for ${ac} of ${e.chapters.length} parts` : '';
    body.append(mk('div', 'meta', `${e.chapters.length} parts · about ${e.minutes} min${audioNote}${pct ? ' · ' + (pct >= 100 ? 'finished' : pct + '% heard') : ''}`));
    if (!removed && !e.user && ac < e.chapters.length) body.append(statusPill(e));
    if (!removed && pct > 0 && pct < 100) {
      const bar = mk('div', 'progress', ''); const fill = document.createElement('div'); fill.style.width = pct + '%'; bar.append(fill); body.append(bar);
    }
    const actions = mk('div', 'actions', '');
    if (removed) {
      const back = mk('button', 'ghost small', 'Bring back');
      back.addEventListener('click', () => { hidden = hidden.filter((id) => id !== e.id); saveHidden(); renderLibrary(); });
      actions.append(back);
      li.append(actions);
      return li;
    }
    const go = mk('button', 'primary', nowPlaying ? 'Open player' : pct > 0 && pct < 100 ? 'Resume' : pct >= 100 ? 'Listen again' : 'Listen');
    go.addEventListener('click', () => {
      if (pct >= 100 && !nowPlaying) { delete progress[e.id]; saveProgress(); }
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
    renderPlaceChips($('place-chips'), [...new Set(visible.map((e) => e.place).filter(Boolean))]);
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
      const first = p.items.map(epById).find(Boolean);
      li.append(first ? coverEl(first) : mk('span', 'cover', ''));
      const body = mk('div', 'card-body');
      body.append(mk('h2', '', p.name));
      const n = p.items.filter(epById).length;
      body.append(mk('div', 'meta', `${n} episode${n === 1 ? '' : 's'} · about ${plMinutes(p)} min`));
      const actions = mk('div', 'actions', '');
      const open = mk('button', 'primary', 'Open');
      open.addEventListener('click', () => { location.hash = '#/p/' + encodeURIComponent(p.id); });
      actions.append(open);
      body.append(actions);
      li.append(body);
      ul.append(li);
    });
  }

  // Redraws every list that is on screen or cheap to keep current.
  function renderLibrary() {
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    $('pane-episodes').hidden = tab !== 'episodes';
    $('pane-playlists').hidden = tab !== 'playlists';
    if (view === 'home') renderHome();
    if (tab === 'episodes') renderEpisodes(); else renderPlaylists();
    if (view === 'search') runSearch($('search-input').value);
  }

  /* ---------- search: every chapter, as you type ---------- */
  const fold = (t) => t.toLowerCase().replace(/[À-ſ]/g, (c) => c.normalize('NFD')[0]);
  let searchIdx = null;
  function buildSearchIndex() {
    searchIdx = library.map((e) => ({
      e,
      head: fold([e.title, e.place, e.blurb].join(' ')),
      ch: e.chapters.map((c) => { const raw = c.paragraphs.map((p) => p.replace(SPEAKER_RE, '')).join(' '); return { raw, low: fold(raw), label: fold(c.label) }; }),
    }));
  }
  function highlight(text, tokens) {
    const low = fold(text), spans = [];
    tokens.forEach((t) => { let i = low.indexOf(t); while (i >= 0) { spans.push([i, i + t.length]); i = low.indexOf(t, i + t.length); } });
    spans.sort((a, b) => a[0] - b[0]);
    const out = document.createDocumentFragment(); let pos = 0;
    spans.forEach(([a, b]) => {
      if (a < pos) return;
      if (a > pos) out.append(text.slice(pos, a));
      out.append(mk('mark', '', text.slice(a, b))); pos = b;
    });
    if (pos < text.length) out.append(text.slice(pos));
    return out;
  }
  function runSearch(q) {
    const box = $('search-results');
    box.textContent = '';
    const tokens = fold(q).split(/[^a-z0-9']+/).filter((t) => t.length > 1);
    if (!tokens.length) {
      box.append(mk('p', 'lede', 'Search names, places and events across every chapter of every episode.'));
      return;
    }
    if (!searchIdx) buildSearchIndex();
    const found = [];
    searchIdx.forEach((it) => {
      if (hidden.includes(it.e.id) || !isPrimary(it.e)) return;
      const headHit = tokens.every((t) => it.head.includes(t));
      const hits = [];
      it.ch.forEach((c, n) => {
        if (!tokens.every((t) => c.low.includes(t) || c.label.includes(t))) return;
        let score = 0; tokens.forEach((t) => { let i = c.low.indexOf(t), k = 0; while (i >= 0 && k < 8) { k++; i = c.low.indexOf(t, i + t.length); } score += k; });
        if (tokens.every((t) => c.label.includes(t))) score += 6;
        hits.push({ n, score });
      });
      if (!headHit && !hits.length) return;
      hits.sort((a, b) => b.score - a.score);
      found.push({ it, headHit, hits: hits.slice(0, 3), score: (headHit ? 30 : 0) + hits.slice(0, 2).reduce((m, h) => m + h.score, 0) });
    });
    found.sort((a, b) => b.score - a.score);
    if (!found.length) { box.append(mk('p', 'lede', 'Nothing found for “' + q.trim() + '”. Try a shorter word or another spelling.')); return; }
    found.slice(0, 12).forEach(({ it, hits }) => {
      const e = it.e;
      const r = mk('div', 'result', '');
      r.append(coverEl(e));
      const col = mk('div', '', '');
      const h = mk('h3', '', ''); const tb = mk('button', 'hit-title', e.title); tb.type = 'button';
      tb.addEventListener('click', () => { location.hash = '#/e/' + encodeURIComponent(e.id); });
      h.append(tb); col.append(h);
      hits.forEach((hit) => {
        const c = it.ch[hit.n];
        const first = Math.min(...tokens.map((t) => { const i = c.low.indexOf(t); return i < 0 ? 1e9 : i; }));
        let start = first >= 1e9 ? 0 : Math.max(0, first - 70);
        if (start > 0) { const sp = c.raw.indexOf(' ', start); if (sp >= 0 && sp < first) start = sp + 1; }
        const piece = c.raw.slice(start, start + 190);
        const b = mk('button', 'hit', ''); b.type = 'button';
        const sm = mk('small', '', e.chapters[hit.n].label);
        const sp = mk('span', '', '');
        sp.append((start > 0 ? '…' : ''), highlight(piece, tokens), (start + 190 < c.raw.length ? '…' : ''));
        b.append(sm, sp);
        b.addEventListener('click', () => { location.hash = '#/e/' + encodeURIComponent(e.id) + '?ch=' + hit.n + '&q=' + encodeURIComponent(q.trim()); });
        col.append(b);
      });
      r.append(col);
      box.append(r);
    });
  }

  /* ---------- create: build a request for Claude (sending it from the app comes later) ---------- */
  function buildRequest() {
    const kind = $('cr-kind').value, place = $('cr-place').value.trim();
    const spec = { overview: 'about 12 minutes of audio (roughly 1,800 words), 5 or 6 short chapters', walk: 'about 30 to 40 minutes of audio (roughly 4,500 to 6,000 words), one chapter per stop, with turn-by-turn directions and a short pause cue at each stop', deep: 'about an hour or more of audio (roughly 9,000 words or more), 8 to 10 chapters' }[kind];
    const lines = [
      'Please write a new Travel Podcasts episode and add it to the travel-podcasts repo. Follow tools/STYLE.md and the format of the existing episodes (front matter with title, place, order, blurb, speakers, voices and format, then a Welcome and numbered Chapters, then Sources consulted). Two-host episodes use Anna and Ben with engine: chatterbox; walking tours also need stops: (latitude,longitude for each stop), hints: (one line on how to find each stop) and maps: (one Google Maps search per stop, the landmark name and city, separated by |).',
      '',
      `Format: ${FORMATS[kind].label} (format: ${kind}), ${spec}.`,
      `Place: ${place || '(not given)'}`,
    ];
    const stops = $('cr-stops').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (kind === 'walk' && stops.length) { lines.push('Stops, in order:'); stops.forEach((x, i) => lines.push(`${i + 1}. ${x}`)); }
    if ($('cr-time').value.trim()) lines.push(TIME_ASK[kind].line + $('cr-time').value.trim());
    if ($('cr-interests').value.trim()) lines.push('What we care about: ' + $('cr-interests').value.trim());
    lines.push('Style: ' + $('cr-style').value + '.');
    if ($('cr-notes').value.trim()) lines.push('Practical notes: ' + $('cr-notes').value.trim());
    lines.push('', 'Research the facts on the web, keep to what the sources support, and list them under Sources consulted. Write years as numerals, except three-digit years, which are spelled out in words. Push it to main so the audio is built automatically.');
    return lines.join('\n');
  }
  const relay = () => { const r = store.get('tp.relay', {}); return { url: String(r.url || '').trim().replace(/\/+$/, ''), code: String(r.code || '').trim() }; };
  const relayReady = () => { const r = relay(); return !!(r.url && r.code); };
  // The same question means different things for each kind, so it is worded for the kind chosen.
  const TIME_ASK = {
    walk: { label: 'How long will you be out walking?', hint: 'About 2 hours, with a coffee stop', line: 'How long we will be out walking: ' },
    overview: { label: 'How much time will you have in the place?', hint: 'One day in port, mostly free time', line: 'Time we have in the place: ' },
    deep: { label: 'When will you listen?', hint: 'A long drive tomorrow, about 3 hours', line: 'When we will listen: ' },
  };
  function syncCreateForm() {
    $('cr-stops-wrap').hidden = $('cr-kind').value !== 'walk';
    const ta = TIME_ASK[$('cr-kind').value]; $('cr-time-label').textContent = ta.label; $('cr-time').placeholder = ta.hint;
    const ready = relayReady();
    $('cr-send').hidden = !ready;
    $('cr-copy').classList.toggle('ghost', ready); $('cr-copy').classList.toggle('primary', !ready);
    $('cr-copy').textContent = ready ? 'Copy the request instead' : 'Copy request for Claude';
    $('cr-send').textContent = online() ? 'Send to Claude' : 'Save to send when online';
    $('cr-hint').hidden = ready;
    if (ready) loadRequests();
  }
  async function relayPost(body) {
    const r = relay();
    const res = await fetch(r.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Family-Code': r.code }, body: JSON.stringify(body) });
    let data = null; try { data = await res.json(); } catch (e) { /* not json */ }
    return { ok: res.ok && !!(data && data.ok), status: res.status, data };
  }
  async function sendRequest() {
    const place = $('cr-place').value.trim();
    if (!place) { $('cr-status').textContent = 'Say which place the episode is about first.'; $('cr-place').focus(); return; }
    const btn = $('cr-send'), out = $('cr-status');
    btn.disabled = true; out.textContent = 'Sending\u2026';
    const label = FORMATS[$('cr-kind').value].label + ': ' + place;
    const body = { title: label, text: buildRequest() };
    const done = (queued) => {
      out.className = 'cr-ok';
      out.textContent = queued
        ? 'No connection right now. Your request is saved on this phone as "' + label + '" and goes out by itself the next time the app is open with a connection. You can ask for another.'
        : 'Sent: ' + label + '. ' + etaText('open') + ' The form is clear, so you can ask for another.';
      showToast(queued ? 'Saved. Will send when you are online.' : 'Request sent.');
      $('create-form').reset(); $('cr-out').hidden = true; syncCreateForm();
      justSent = { title: label, at: Date.now() };
      loadRequests();
      out.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (!queued) setTimeout(loadRequests, 3000);
    };
    try {
      if (!navigator.onLine) throw new TypeError('offline');
      const r = await relayPost(body);
      if (r.ok) done(false);
      else { out.className = 'fine'; out.textContent = (r.data && r.data.error) || ('The relay answered ' + r.status + '.'); }
    } catch (err) { queueOutbox({ kind: 'request', title: label, body }); done(true); }
    btn.disabled = false;
  }

  /* ---------- outbox: requests made with no connection wait on the phone and go out later ---------- */
  const outbox = () => store.get('tp.outbox', []) || [];
  function queueOutbox(item) { const q = outbox(); q.push(Object.assign({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), at: Date.now() }, item)); store.set('tp.outbox', q); }
  const dropOutbox = (id) => store.set('tp.outbox', outbox().filter((x) => x.id !== id));
  let flushing = false;
  async function flushOutbox() {
    if (flushing || !relayReady() || !outbox().length || !navigator.onLine) return;
    flushing = true;
    try {
      for (const item of outbox()) {
        let r;
        try { r = item.kind === 'report' ? await postReport(item.title, item.lines) : await relayPost(item.body); } catch (err) { break; } // still no connection: try again later
        if (r.ok) { dropOutbox(item.id); showToast('Sent: ' + item.title); justSent = { title: item.title, at: Date.now() }; }
        else if (r.status === 429 || r.status >= 500) break;                    // relay busy or down: keep it
        else { dropOutbox(item.id); showToast('A saved request was refused: ' + ((r.data && r.data.error) || r.status)); }
      }
    } finally { flushing = false; }
    if (view === 'create') loadRequests();
  }
  // A newer relay files reports under their own label; an older one gets a request titled "Problem report:".
  async function postReport(title, lines) {
    const p = await relayPost({ ping: true });
    const legacy = p.ok && !(p.data && p.data.feedback);
    return relayPost(legacy ? { title: 'Problem report: ' + title, text: 'PROBLEM REPORT (not an episode request)\n' + lines.join('\n') } : { kind: 'feedback', title, text: lines.join('\n') });
  }

  // ---- Report a problem: goes through the same relay as episode requests, labelled "episode-feedback" ----
  const REPORT_HINTS = {
    name: ['Which word, and how should it sound?', 'For example: Scheldt sounds like Shelled, it is said Skelt'],
    pin: ['Where should the pin be?', 'For example: the church is on the other side of the square'],
    fact: ['What seems wrong, and what is right?', 'For example: the tower is older than it says'],
    other: ['Tell us what happened', 'Anything that sounded or looked off'],
  };
  function reportContext() {
    if (!ep) return null;
    const ch = ep.chapters[chIdx] || {};
    const st = walkState() ? stopsOf(ep)[walkSel] : null;
    let at = ''; try { if (mode === 'audio' && audioEl.currentTime) at = ' at ' + Math.floor(audioEl.currentTime / 60) + ':' + String(Math.floor(audioEl.currentTime % 60)).padStart(2, '0'); } catch (e) { /* none */ }
    return { id: ep.id, title: ep.title, chapter: ch.label || '', num: chIdx + 1, at, stop: st };
  }
  function openReport(pinFirst) {
    const c = reportContext(); if (!c) return;
    $('rp-where').textContent = c.title + ' \u00b7 ' + c.chapter + c.at;
    $('rp-note').value = ''; $('rp-status').textContent = '';
    const kinds = document.getElementsByName('rp-kind');
    kinds.forEach((r) => { r.checked = r.value === (pinFirst ? 'pin' : 'name'); });
    syncReportHint();
    $('rp-send').disabled = false;
    $('dlg-report').showModal();
  }
  function syncReportHint() {
    const k = (document.querySelector('input[name="rp-kind"]:checked') || {}).value || 'name';
    $('rp-note-label').textContent = REPORT_HINTS[k][0]; $('rp-note').placeholder = REPORT_HINTS[k][1];
  }
  async function sendReport() {
    const c = reportContext(), out = $('rp-status');
    const k = (document.querySelector('input[name="rp-kind"]:checked') || {}).value || 'other';
    const note = $('rp-note').value.trim();
    if (note.length < 3) { out.textContent = 'Add a few words so Claude knows what to fix.'; $('rp-note').focus(); return; }
    if (!relayReady()) { out.textContent = 'Reports need the request relay. Set it up in Settings first.'; return; }
    const names = { name: 'Name or word sounds wrong', pin: 'Pin in the wrong place', fact: 'Fact seems wrong', other: 'Other problem' };
    const lines = ['Problem type: ' + names[k], 'Episode: ' + c.title + ' (id: ' + c.id + ')', 'Chapter ' + c.num + ': ' + c.chapter + c.at];
    if (c.stop) lines.push('Stop selected on the map: ' + (c.stop.k + 1) + ', ' + c.stop.name + ' (pin now at ' + c.stop.lat + ', ' + c.stop.lon + ')');
    lines.push('', 'What the listener said: ' + note);
    $('rp-send').disabled = true; out.textContent = 'Sending\u2026';
    const title = names[k] + ': ' + c.title + ', ' + c.chapter;
    try {
      if (!navigator.onLine) throw new TypeError('offline');
      const r = await postReport(title, lines);
      if (r.ok) { $('dlg-report').close(); showToast('Report sent. Claude will fix it on the next pass.'); return; }
      out.textContent = (r.data && r.data.error) || ('The relay answered ' + r.status + '.');
    } catch (err) {
      queueOutbox({ kind: 'report', title: 'Problem report: ' + title, lines });
      $('dlg-report').close(); showToast('No connection. The report is saved and will send when you are online.'); return;
    }
    $('rp-send').disabled = false;
  }

  /* ---------- when Claude next checks for requests (the scheduled task runs at these Brussels times) ---------- */
  const RUNS = { tz: 'Europe/Brussels', hours: [7, 10, 13, 16, 19], minute: 17, busyMin: 25 };
  function runClock(now) {
    now = now || new Date();
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: RUNS.tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
    const g = (t) => +f.find((x) => x.type === t).value;
    const nowSec = g('hour') * 3600 + g('minute') * 60 + g('second');
    const slots = RUNS.hours.map((h) => h * 3600 + RUNS.minute * 60);
    let next = slots.find((s) => s > nowSec), wait;
    if (next == null) { next = slots[0] + 86400; }
    wait = (next - nowSec) * 1000 - now.getMilliseconds();
    const past = slots.filter((s) => s <= nowSec).pop();
    const sinceLast = past == null ? (nowSec + 86400 - slots[slots.length - 1]) / 60 : (nowSec - past) / 60;
    return { at: new Date(now.getTime() + wait), wait, running: sinceLast < RUNS.busyMin };
  }
  function untilText(ms) {
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), r = m % 60;
    return h + ' h' + (r ? ' ' + r + ' min' : '');
  }
  const clockText = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // One line for a request that has not been written yet; refreshed every 30 seconds by tickEta().
  function etaText(state) {
    if (state === 'queued') return 'Saved on this phone. It sends as soon as you are online.';
    const c = runClock();
    if (c.running) return 'Claude is checking requests right now. Writing takes about 5 to 15 minutes, then the audio takes 25 to 40.';
    return 'Claude\u2019s next check is at ' + clockText(c.at) + ', in ' + untilText(c.wait) + '. Then about 5 to 15 minutes to write and 25 to 40 for the audio.';
  }
  function tickEta() { document.querySelectorAll('[data-eta]').forEach((el) => { el.textContent = etaText(el.dataset.eta); }); }
  let justSent = null;
  // "Overview: Antwerp" -> the newest matching episode, so a finished request opens straight to its result
  function requestEpisode(title) {
    const m = String(title).replace(/^Episode request:\s*/i, '').match(/^(Overview|Walking tour|Deep dive):\s*(.+)$/i);
    if (!m) return null;
    const fmt = Object.keys(FORMATS).find((k) => FORMATS[k].label.toLowerCase() === m[1].toLowerCase());
    const place = fold(m[2]);
    const hits = library.filter((e) => !e.user && fmtOf(e) === fmt && fold(e.place || '') === place);
    if (!hits.length) return null;
    return hits.sort((x, y) => (isNew(y) - isNew(x)) || (y.order - x.order))[0];
  }
  function drawRequests(items, note) {
    const ul = $('cr-list'); ul.textContent = '';
    const queued = outbox().map((x) => ({ title: x.title, state: 'queued' }));
    if (queued.length) items = queued.concat(items.filter((x) => !queued.some((q) => q.title === x.title.replace(/^Episode request:\s*/i, ''))));
    if (justSent && Date.now() - justSent.at < 300000 && !items.some((x) => x.title.replace(/^Episode request:\s*/i, '') === justSent.title)) items = [{ title: justSent.title, state: 'open' }].concat(items);
    items.forEach((x) => {
      const li = mk('li', ''), t = mk('span', 'rq-t', x.title.replace(/^Episode request:\s*/i, ''));
      const found = x.state === 'closed' ? requestEpisode(x.title) : null;
      if (found) {
        const ac = audioCount(found), total = found.chapters.length;
        const b = mk('button', 'rq-s done link', ac >= total ? 'Open' : 'Open \u00b7 audio ' + ac + '/' + total);
        b.type = 'button'; b.setAttribute('aria-label', 'Open ' + found.title);
        b.addEventListener('click', () => { location.hash = '#/e/' + encodeURIComponent(found.id); });
        li.append(t, b);
      } else li.append(t, mk('span', 'rq-s' + (x.state === 'closed' ? ' done' : ''), x.state === 'closed' ? 'Done' : x.state === 'queued' ? 'Waiting to send' : 'Waiting'));
      if (x.state !== 'closed') { const eta = mk('span', 'rq-eta', etaText(x.state)); eta.dataset.eta = x.state; li.append(eta); }
      ul.append(li);
    });
    $('cr-list-note').textContent = note || '';
    $('cr-recent').hidden = !items.length && !note;
  }
  async function loadRequests() {
    const cached = store.get('tp.requests', null);
    try {
      const headers = { 'Accept': 'application/vnd.github+json' };
      if (ghToken()) headers.Authorization = 'Bearer ' + ghToken(); // a saved key lifts GitHub's low limit for anonymous visitors
      const res = await fetch(GH_API + '/repos/' + GH_REPO + '/issues?labels=episode-request&state=all&per_page=8', { headers });
      if (!res.ok) throw new Error(String(res.status));
      const items = (await res.json()).filter((x) => !x.pull_request).map((x) => ({ title: x.title, state: x.state }));
      store.set('tp.requests', { at: Date.now(), items });
      drawRequests(items, '');
      if (view === 'home') renderLibrary();
    } catch (err) {
      // GitHub only allows a few anonymous lookups an hour per network, and a ship's Wi-Fi shares one network
      if (cached && cached.items) drawRequests(cached.items, 'Could not reach GitHub just now. This is the list from ' + new Date(cached.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '. Tap Check again later.');
      else drawRequests([], 'Could not load your requests just now. GitHub limits lookups on shared Wi-Fi. Tap Check again in a few minutes.');
    }
  }

  function syncPhoneBox() { const b = $('phone-box'); if (b) b.hidden = engine() === 'natural'; }

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
    if (ep && ep.id === e.id) { if (playing) pause(); ep = null; updateMini(); }
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
    add('Play next', 'Plays right after the current episode ends.', () => enqueue(e.id, true));
    add('Add to queue', 'Plays after anything already queued.', () => enqueue(e.id, false));
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

  /* ---------- up next ---------- */
  let queue = store.get('tp.queue', []);
  const saveQueue = () => store.set('tp.queue', queue);
  function updateQueueUi() {
    queue = queue.filter(epById);
    const n = queue.length;
    $('queue-label').textContent = n ? 'Up next \u00b7 ' + n : 'Up next';
    $('queue-open').hidden = !n; $('queue-open').textContent = 'Up next \u00b7 ' + n + (n === 1 ? ' episode' : ' episodes');
  }
  function enqueue(id, next) {
    queue = queue.filter((x) => x !== id);
    if (next) queue.unshift(id); else queue.push(id);
    saveQueue(); updateQueueUi();
    showToast(next ? 'It will play next.' : 'Added to your queue.');
  }
  function popQueue() {
    let id = null;
    while (queue.length && !id) { const x = queue.shift(); if (epById(x)) id = x; }
    saveQueue(); updateQueueUi();
    return id;
  }
  function openQueue() {
    queue = queue.filter(epById);
    const ul = $('queue-list'); ul.textContent = '';
    $('queue-clear').hidden = !queue.length;
    if (!queue.length) ul.append(mk('li', 'fine', 'Nothing queued. Use \u22ef on an episode and choose Play next.'));
    queue.forEach((id, i) => {
      const e = epById(id);
      const li = mk('li', 'pl-row');
      const t = mk('span', 'row-title', ''); t.append(mk('span', '', e.title), mk('small', '', `${e.place ? e.place + ' \u00b7 ' : ''}about ${e.minutes} min`));
      li.append(t);
      const btn = (label, aria, fn, disabled) => { const b = mk('button', 'icon-btn', label); b.type = 'button'; b.setAttribute('aria-label', aria); b.disabled = !!disabled; b.addEventListener('click', fn); li.append(b); };
      const move = (d) => () => { const j = i + d; [queue[i], queue[j]] = [queue[j], queue[i]]; saveQueue(); openQueue(); };
      btn('\u2191', 'Move up', move(-1), i === 0);
      btn('\u2193', 'Move down', move(1), i === queue.length - 1);
      btn('\u2715', 'Remove from the queue', () => { queue.splice(i, 1); saveQueue(); updateQueueUi(); openQueue(); });
      ul.append(li);
    });
    if (!$('dlg-queue').open) $('dlg-queue').showModal();
  }

  /* ---------- download a whole playlist for a trip ---------- */
  const mb = (bytes) => (bytes >= 1e8 ? Math.round(bytes / 1e6) : Math.round(bytes / 1e5) / 10) + ' MB';
  function plStats(p) {
    const eps = p.items.map(epById).filter((e) => e && !e.user && audioCount(e) > 0);
    let need = 0, missing = 0, partial = 0, all = true;
    eps.forEach((e) => {
      e.chapters.forEach((_c, n) => { if (!hasAudio(e, n)) missing++; });
      if (!savedOffline(e)) { all = false; e.chapters.forEach((_c, n) => { const a = hasAudio(e, n); if (a) need += a.bytes || 0; }); }
      partial += audioCount(e) < e.chapters.length ? 1 : 0;
    });
    return { eps, need, missing, all };
  }
  let plDownloading = false;
  function renderPlDownload(p) {
    const btn = $('pl-dl'), note = $('pl-dl-note');
    const st = plStats(p);
    btn.hidden = note.hidden = !('caches' in window) || !st.eps.length;
    if (btn.hidden || plDownloading) return;
    btn.disabled = false;
    if (st.all) {
      btn.textContent = 'Saved on this phone \u2713'; btn.className = 'ghost wide';
      note.textContent = 'These episodes play with no signal. Tap to remove the saved audio.';
    } else {
      btn.textContent = 'Download for the trip \u00b7 ' + mb(st.need); btn.className = 'ghost wide';
      note.textContent = 'Saves the audio on this phone so it plays with no signal. Best done on Wi-Fi.';
    }
    if (st.missing) note.textContent += ` ${st.missing} part${st.missing === 1 ? ' has' : 's have'} no audio yet, so download again once ${st.missing === 1 ? 'it is' : 'they are'} ready.`;
    btn.onclick = st.all ? () => removePlaylistDownloads(p) : () => downloadPlaylist(p);
  }
  async function downloadPlaylist(p) {
    const btn = $('pl-dl');
    const eps = plStats(p).eps.filter((e) => !savedOffline(e));
    plDownloading = true; btn.disabled = true;
    try {
      await warmShell();
      for (let i = 0; i < eps.length; i++) {
        await downloadEpisode(eps[i], (part, total) => { btn.textContent = `Downloading episode ${i + 1} of ${eps.length} \u00b7 part ${part} of ${total}\u2026`; });
        await refreshOffline();
      }
      showToast('Ready for the trip.');
    } catch (err) { showToast('Downloading stopped. Check your connection and tap again to carry on.'); }
    plDownloading = false;
    await refreshOffline();
    if (view === 'playlist') renderPlDownload(p);
  }
  async function removePlaylistDownloads(p) {
    if (!confirm('Remove the saved audio for this playlist from this phone? Episodes in other playlists lose it too.')) return;
    for (const e of plStats(p).eps) await removeOffline(e, true);
    renderPlDownload(p);
  }

  function renderPlaylistView(p) {
    p.items = p.items.filter(epById);
    const ul = $('pl-items');
    ul.textContent = '';
    $('pl-play').hidden = !p.items.length;
    renderPlDownload(p);
    $('pl-play').onclick = () => {
      location.hash = '#/e/' + encodeURIComponent(p.items[0]) + '?pl=' + encodeURIComponent(p.id) + '&play=1';
    };
    if (!p.items.length) ul.append(mk('li', 'fine', 'This playlist is empty. Use the ⋯ button on an episode to add it.'));
    p.items.forEach((eid, i) => {
      const e = epById(eid);
      const li = mk('li', 'pl-row');
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
      playlists = playlists.filter((x) => x.id !== p.id); savePlaylists(); location.hash = '#/library';
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
  const SPEAKER_COLORS = ['var(--sp0)', 'var(--sp1)', 'var(--sp2)', 'var(--sp3)'];

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
    updateMini();
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
    if (document.visibilityState === 'visible') { flushOutbox(); if (updatePending && canReloadNow()) location.reload(); else if (updatePending) showUpdateBar(); else checkForUpdate(); if (needsAudio() || audioStatus.active) scheduleAudioPoll(500); }
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
      try { const j = await fetchChapterJson(e, n); return { units: j.units, audio: true, duration: j.duration || 0 }; } catch (err) { /* fall back to the phone voice */ }
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
  // The next chapter's MP3 is downloaded into memory ahead of time, so the hand-over at the end of a chapter
  // needs no network at all (a phone with the screen off may freeze the page the moment audio stops).
  let nextPre = null;      // { key, url } for the chapter after this one
  let curBlobUrl = null;   // blob URL currently loaded in the audio element
  let loadedKey = '';      // which chapter the audio element holds
  function dropPre() { if (nextPre && nextPre.url) URL.revokeObjectURL(nextPre.url); nextPre = null; }
  function preloadNextAudio() {
    if (!(ep && chIdx + 1 < ep.chapters.length && audioEntry(ep, chIdx + 1))) return;
    const key = ep.id + ':' + (chIdx + 1);
    if (nextPre && nextPre.key === key) return;
    dropPre();
    const rec = { key, url: null };
    nextPre = rec;
    fetch(audioUrl(ep, chIdx + 1, 'mp3'))
      .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.blob(); })
      .then((blob) => { if (nextPre === rec) rec.url = URL.createObjectURL(blob); })
      .catch(() => { if (nextPre === rec) nextPre = null; });
  }
  function prefetchNext(warmAudio) {
    if (!(ep && chIdx + 1 < ep.chapters.length && audioEntry(ep, chIdx + 1))) return;
    fetchChapterJson(ep, chIdx + 1).catch(() => {});
    if (warmAudio) preloadNextAudio();
  }

  // Hand over to the next chapter inside the 'ended' event itself. When the screen is off or another app is in
  // front, the phone may freeze this page the moment audio stops, so nothing may wait on the network here.
  function fastNext() {
    const n = chIdx + 1;
    if (!settings.autonext || !ep || n >= ep.chapters.length || mode !== 'audio' || (sleep && sleep.chapter)) return false;
    if (!audioEntry(ep, n) || audioFailed.has(ep.id + ':' + n)) return false;
    const data = jsonCache.get(audioUrl(ep, n, 'json'));
    if (!data || data.hash !== ep.chapters[n].hash) return false;
    const key = ep.id + ':' + n;
    let src = new URL(audioUrl(ep, n, 'mp3'), location.href).href;
    let blobUrl = null;
    if (nextPre && nextPre.key === key && nextPre.url) { blobUrl = nextPre.url; src = blobUrl; nextPre = null; }
    const oldBlob = curBlobUrl;
    audioEl.src = src; loadedKey = key; curBlobUrl = blobUrl;
    if (oldBlob) URL.revokeObjectURL(oldBlob);
    audioEl.playbackRate = settings.rate;
    const hold = holdBefore(n); // walking tour: wait at the end of a stop until you arrive at the next one
    if (hold >= 0) { playing = false; setPlayingUi(); unlockScreen(); }
    else {
      const p = audioEl.play();
      if (p && p.catch) p.catch((err) => { if (!err || err.name !== 'AbortError') { playing = false; setPlayingUi(); unlockScreen(); showToast('Tap play to carry on.'); } });
    }
    loadSeq++; chIdx = n; idx = 0; pendingSeek = null;
    renderChapter({ units: data.units, audio: true });
    mark(0, true); remember(false);
    if (hold >= 0) beginWait(hold);
    return true;
  }

  audioEl.addEventListener('loadedmetadata', () => {
    if (pendingSeek !== null) { audioEl.currentTime = pendingSeek; pendingSeek = null; }
    setPosition(); updateScrub();
  });
  audioEl.addEventListener('timeupdate', () => {
    if (mode !== 'audio' || !units.length || pendingSeek !== null) return;
    const t = audioEl.currentTime;
    let lo = 0, hi = units.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (units[mid].t <= t + 0.05) lo = mid; else hi = mid - 1; }
    if (lo !== idx) { idx = lo; mark(lo, !audioEl.paused); remember(false); }
    const d = audioEl.duration;
    updateScrub();
    if (sleep && sleep.at && Date.now() >= sleep.at) sleepNow();
    if (d) {
      setBar(Math.round((t / d) * 100));
      if (t > d * 0.6 && !nextPre) prefetchNext(true);
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
  let chDuration = 0, wordsPre = [0], scrubbing = false;
  const fmtTime = (sec) => { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
  function drawHero() {
    if (!ep) return;
    $('hero-cover').textContent = ''; $('hero-cover').append(coverEl(ep));
    $('hero-title').textContent = ep.title;
    $('hero-sub').textContent = [ep.place, FORMATS[fmtOf(ep)].label, variantOf(ep)].filter(Boolean).join(' \u00b7 ');
    const fam = family(ep);
    $('ver-btn').hidden = fam.length < 2;
    $('ver-label').textContent = variantOf(ep);
  }
  function updateScrub(force) {
    if (scrubbing && !force) return;
    const sc = $('scrubber');
    if (!ep) return;
    if (mode === 'audio') {
      const d = (audioEl.duration && isFinite(audioEl.duration)) ? audioEl.duration : chDuration;
      if (!d) { sc.value = 0; $('t-cur').textContent = '0:00'; $('t-left').textContent = ''; return; }
      const t = Math.min(audioEl.currentTime || 0, d);
      sc.value = Math.round((t / d) * 1000); sc.style.setProperty('--p', sc.value / 10 + '%');
      $('t-cur').textContent = fmtTime(t);
      $('t-left').textContent = '-' + fmtTime((d - t) / (settings.rate || 1));
    } else {
      const total = wordsPre[wordsPre.length - 1] || 1, at = wordsPre[Math.min(idx, wordsPre.length - 1)] || 0;
      const wps = (WPM / 60) * (settings.rate || 1);
      sc.value = Math.round((at / total) * 1000); sc.style.setProperty('--p', sc.value / 10 + '%');
      $('t-cur').textContent = fmtTime(at / wps);
      $('t-left').textContent = '-' + fmtTime((total - at) / wps);
    }
  }
  function onScrubInput() {
    scrubbing = true;
    const v = $('scrubber').value / 1000;
    $('scrubber').style.setProperty('--p', v * 100 + '%');
    if (mode === 'audio') {
      const d = (audioEl.duration && isFinite(audioEl.duration)) ? audioEl.duration : chDuration;
      $('t-cur').textContent = fmtTime(v * d);
      $('t-left').textContent = '-' + fmtTime((1 - v) * d / (settings.rate || 1));
    } else {
      const total = wordsPre[wordsPre.length - 1] || 1, wps = (WPM / 60) * (settings.rate || 1);
      $('t-cur').textContent = fmtTime(v * total / wps);
      $('t-left').textContent = '-' + fmtTime((1 - v) * total / wps);
    }
  }
  function onScrubCommit() {
    const v = $('scrubber').value / 1000;
    scrubbing = false;
    if (!ep || !units.length) return;
    if (mode === 'audio') {
      const d = (audioEl.duration && isFinite(audioEl.duration)) ? audioEl.duration : chDuration;
      if (audioEl.readyState >= 1) audioEl.currentTime = v * d; else pendingSeek = v * d;
      let lo = 0; units.forEach((u, i) => { if (u.t <= v * d + 0.05) lo = i; });
      idx = lo; mark(lo, true); remember(false);
    } else {
      const target = v * (wordsPre[wordsPre.length - 1] || 1);
      let i = 0; while (i < units.length - 1 && wordsPre[i + 1] <= target) i++;
      idx = i; mark(i, true); remember(false);
      if (playing) start(i);
    }
  }

  /* ---------- sleep timer ---------- */
  let sleep = null, sleepT = null, sleepTick = null; // sleep: { at } minutes from now, or { chapter: true }
  function updateSleepLabel() {
    let t = 'Sleep';
    if (sleep && sleep.chapter) t = 'Sleep \u00b7 end of chapter';
    else if (sleep && sleep.at) t = 'Sleep \u00b7 ' + Math.max(1, Math.round((sleep.at - Date.now()) / 60000)) + ' min';
    $('sleep-label').textContent = t;
    $('sleep-btn').classList.toggle('on', !!sleep);
  }
  function setSleep(opt) {
    clearTimeout(sleepT); clearInterval(sleepTick); sleepT = sleepTick = null; sleep = null;
    if (opt === 'chapter') sleep = { chapter: true };
    else if (opt > 0) { sleep = { at: Date.now() + opt * 60000 }; sleepT = setTimeout(sleepNow, opt * 60000); }
    if (sleep) sleepTick = setInterval(updateSleepLabel, 15000);
    updateSleepLabel();
  }
  function sleepNow() {
    clearTimeout(sleepT); clearInterval(sleepTick); sleepT = sleepTick = null; sleep = null; updateSleepLabel();
    if (!playing) return;
    showToast('Sleep timer: paused.');
    if (mode === 'audio') {
      let v = 1;
      const f = setInterval(() => {
        v -= 0.125;
        if (v <= 0.01) { clearInterval(f); pause(); try { audioEl.volume = 1; } catch (e) { /* optional */ } } else { try { audioEl.volume = v; } catch (e) { /* optional */ } }
      }, 300);
    } else pause();
  }
  function openSleep() {
    const box = $('sleep-opts'); box.textContent = '';
    const cur = !sleep ? 'off' : sleep.chapter ? 'chapter' : 'time';
    [['Off', 'off', 0], ['15 minutes', 'time', 15], ['30 minutes', 'time', 30], ['45 minutes', 'time', 45], ['1 hour', 'time', 60], ['At the end of this chapter', 'chapter', 'chapter']].forEach(([label, kind, val]) => {
      const b = mk('button', 'opt', label); b.type = 'button';
      if (kind === cur && (kind !== 'time')) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => { $('dlg-sleep').close(); setSleep(val === 0 ? 0 : val); showToast(kind === 'off' ? 'Sleep timer off.' : 'Sleep timer set.'); });
      box.append(b);
    });
    $('dlg-sleep').showModal();
  }

  /* ---------- the other version of the same episode ---------- */
  function openVersions() {
    const box = $('ver-opts'); box.textContent = '';
    family(ep).forEach((x) => {
      const b = mk('button', 'opt', ''); b.type = 'button';
      b.append(mk('span', '', variantOf(x)), mk('small', '', `about ${x.minutes} min`));
      if (x.id === ep.id) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => {
        $('dlg-ver').close();
        if (x.id === ep.id) return;
        const frac = units.length ? Math.round((idx / units.length) * 1000) / 1000 : 0;
        location.hash = '#/e/' + encodeURIComponent(x.id) + '?ch=' + chIdx + '&f=' + frac + (curPl ? '&pl=' + encodeURIComponent(curPl) : '') + (playing ? '&play=1' : '');
      });
      box.append(b);
    });
    $('dlg-ver').showModal();
  }

  function renderChapter(data) {
    const ch = ep.chapters[chIdx];
    units = data.units;
    chDuration = data.duration || 0;
    let acc = 0; wordsPre = [0];
    units.forEach((u) => { acc += u.text.split(/\s+/).length; wordsPre.push(acc); });
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
      const key = ep.id + ':' + chIdx;
      if (loadedKey !== key) {
        audioEl.src = new URL(audioUrl(ep, chIdx, 'mp3'), location.href).href; loadedKey = key;
        if (curBlobUrl) { URL.revokeObjectURL(curBlobUrl); curBlobUrl = null; }
      }
      audioEl.playbackRate = settings.rate;
      prefetchNext(false);
    } else if (audioEl.getAttribute('src')) {
      audioEl.removeAttribute('src'); audioEl.load(); loadedKey = '';
      if (curBlobUrl) { URL.revokeObjectURL(curBlobUrl); curBlobUrl = null; }
    }
    $('ch-label').textContent = ch.label;
    $('report-btn').hidden = !relayReady(); $('walk-report').hidden = !relayReady();
    following = true; hideFollowPill(); syncFollowUi();
    drawHero();
    updateScrub(true);
    $('ch-meta').textContent = `${chIdx + 1} of ${ep.chapters.length} · ${mode === 'audio' ? 'natural voice' : naturalOnly(ep) ? 'audio ' + STATE_TEXT[chapterState(ep, chIdx)] : 'phone voice'}`;
    updateWalkCard();
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
    if (!(mode === 'audio' && audioEl.duration)) setBar(units.length ? Math.round((i / units.length) * 100) : 0);
    updateScrub();
    if (scroll && spans[i] && settings.follow && following) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      spans[i].scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }
    updateFollowPill();
  }

  function remember(done) {
    if (!ep) return;
    const t = Date.now();
    progress[ep.id] = done ? { ch: ep.chapters.length - 1, u: units.length, n: units.length, done: true, t } : { ch: chIdx, u: idx, n: units.length, t };
    saveProgress();
  }

  /* ---------- views and the mini player (playback carries on while you browse) ---------- */
  let view = 'home'; // 'home' | 'search' | 'library' | 'create' | 'playlist' | 'player'
  let lastTab = '#/';
  const TAB_HASH = { home: '#/', search: '#/search', library: '#/library', create: '#/create' };
  const TITLES = { home: 'Travel Podcasts', search: 'Search', library: 'Library', create: 'Create' };
  function setBar(pct) { $('bar-fill').style.width = pct + '%'; $('mini-fill').style.width = pct + '%'; }
  function updateMini() {
    const show = !!ep && view !== 'player';
    $('mini').hidden = !show;
    document.body.classList.toggle('has-mini', show);
    if (!show) return;
    $('mini-title').textContent = ep.chapters[chIdx] ? ep.chapters[chIdx].label : ep.title;
    $('mini-sub').textContent = ep.title + (playing ? '' : ' \u00b7 paused');
    $('mini-ico-play').toggleAttribute('hidden', playing); $('mini-ico-pause').toggleAttribute('hidden', !playing);
    $('mini-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  function setView(v) {
    view = v;
    ['home', 'search', 'create', 'library', 'playlist', 'player'].forEach((n) => { $('view-' + n).hidden = n !== v; });
    $('transport').hidden = v !== 'player';
    if (v !== 'player' && walkWatch != null) stopWalkGps(); // no location tracking while you are elsewhere in the app (your choice is remembered)
    document.body.classList.toggle('v-player', v === 'player');
    const isTab = !!TAB_HASH[v];
    $('back').hidden = isTab;
    $('as-wrap').hidden = !(v === 'home' || v === 'library');
    const active = isTab ? v : v === 'playlist' ? 'library' : null;
    document.querySelectorAll('#tabbar a').forEach((a) => { if (a.dataset.tab === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (isTab) { lastTab = TAB_HASH[v]; $('title').textContent = TITLES[v]; document.title = v === 'home' ? 'Travel Podcasts' : TITLES[v] + ' \u00b7 Travel Podcasts'; }
    window.scrollTo({ top: 0 });
    updateMini();
  }

  function setPlayingUi() {
    if (playing) { waitFor = null; arrivePrompt = null; }
    updateMini();
    $('ico-play').toggleAttribute('hidden', playing);
    $('ico-pause').toggleAttribute('hidden', !playing);
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) { /* optional */ } }
    syncArrive();
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
      showToast('Audio for this part is ' + STATE_TEXT[chapterState(ep, chIdx)] + '. Choose "Always use my phone\'s voice" in Settings to listen now.');
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

  async function gotoChapter(n, keepPlaying, at, frac) {
    if (!ep || n < 0 || n >= ep.chapters.length) return;
    const seq = ++loadSeq;
    stopAll();
    chIdx = n; idx = at || 0;
    const data = await loadUnits(ep, n);
    if (seq !== loadSeq) return;
    renderChapter(data);
    if (frac != null) idx = Math.floor(frac * units.length);
    idx = Math.min(idx, Math.max(0, units.length - 1));
    if (mode === 'audio') seekToUnit(idx);
    mark(idx, false);
    if (view === 'player') window.scrollTo({ top: 0 });
    remember(false);
    switching = false;
    if (keepPlaying) play(); else { playing = false; setPlayingUi(); }
  }

  async function chapterDone() {
    if (sleep && sleep.chapter) {
      setSleep(0); showToast('Sleep timer: stopped at the end of the chapter.');
      if (chIdx + 1 < ep.chapters.length) { await gotoChapter(chIdx + 1, false); return; }
      playing = false; stopAll(); switching = false; setPlayingUi(); unlockScreen(); remember(true); return;
    }
    if (settings.autonext && chIdx + 1 < ep.chapters.length && holdBefore(chIdx + 1) >= 0) {
      const k = holdBefore(chIdx + 1);
      playing = false; stopAll(); switching = false; setPlayingUi(); unlockScreen();
      await gotoChapter(chIdx + 1, false); beginWait(k); return;
    }
    if (settings.autonext && chIdx + 1 < ep.chapters.length) { await gotoChapter(chIdx + 1, true); return; }
    const last = chIdx + 1 >= ep.chapters.length;
    playing = false; stopAll(); switching = false; setPlayingUi(); unlockScreen();
    if (last) {
      remember(true);
      const q = popQueue();
      const nx = q || nextInPlaylist();
      const pl = q ? null : curPl;
      if (nx) {
        showToast(q ? 'Next in your queue\u2026' : 'Next in your playlist\u2026');
        if (view === 'player') location.hash = '#/e/' + encodeURIComponent(nx) + (pl ? '?pl=' + encodeURIComponent(pl) + '&play=1' : '?play=1');
        else showEpisode(nx, pl, true, true);
        return;
      }
      showToast('Episode finished.');
    } else await gotoChapter(chIdx + 1, false);
  }

  /* ---------- views and routing ---------- */
  function showHome() { setView('home'); renderLibrary(); }
  function showLibrary() {
    setView('library');
    renderLibrary();
    if ('caches' in window) refreshOffline().then(() => { renderLibrary(); });
  }
  function showSearch() {
    setView('search');
    runSearch($('search-input').value);
    if (!$('search-input').value) setTimeout(() => { try { $('search-input').focus(); } catch (e) { /* optional */ } }, 50);
  }
  function showCreate() { setView('create'); syncCreateForm(); }

  function showPlaylist(id) {
    const p = plById(id);
    if (!p) { location.hash = '#/library'; return; }
    tab = 'playlists'; store.set('tp.tab', tab);
    setView('playlist');
    $('title').textContent = p.name; document.title = p.name + ' \u00b7 Travel Podcasts';
    renderPlaylistView(p);
  }

  function enterPlayerView() {
    setView('player');
    $('title').textContent = ep.place || 'Now playing'; document.title = ep.title + ' \u00b7 Travel Podcasts';
    drawHero(); updateScrub(true);
  }

  // Coming from a search result: move to the first sentence that mentions what was searched for.
  function jumpToQuery(q) {
    if (!q || !units.length) return;
    const tk = fold(q).split(/[^a-z0-9']+/).filter((t) => t.length > 1);
    if (!tk.length) return;
    let j = units.findIndex((u) => tk.every((t) => fold(u.text).includes(t)));
    if (j < 0) j = units.findIndex((u) => fold(u.text).includes(tk[0]));
    if (j < 0) return;
    idx = j; if (mode === 'audio') seekToUnit(j);
    mark(j, false); remember(false);
    setTimeout(() => mark(j, true), 80);
  }

  // quiet: load and start an episode without taking over the screen (the next playlist item while you browse)
  async function showEpisode(id, plId, autoplay, quiet, opts) {
    opts = opts || {};
    const found = library.find((e) => e.id === id);
    if (!found) { if (!quiet) location.hash = '#/'; return; }
    markSeen(id);
    if (plId && plById(plId)) curPl = plId;
    else if (!(ep && ep.id === id)) curPl = null;
    if (ep && ep.id === id) { // already loaded: just show it, never restart it
      if (!quiet) enterPlayerView();
      if (opts.ch != null && opts.ch !== chIdx && ep.chapters[opts.ch]) { await gotoChapter(opts.ch, autoplay || playing); jumpToQuery(opts.q); }
      else { if (opts.q) jumpToQuery(opts.q); else if (!quiet) setTimeout(() => mark(idx, true), 50); }
      if (autoplay && !playing) play();
      return;
    }
    if (queue.includes(found.id)) { queue = queue.filter((x) => x !== found.id); saveQueue(); updateQueueUi(); }
    if (playing) pause();
    ep = found;
    const pr = progress[ep.id];
    const forced = opts.ch != null && ep.chapters[Math.min(opts.ch, ep.chapters.length - 1)] ? Math.min(opts.ch, ep.chapters.length - 1) : null;
    const ch = forced != null ? forced : pr && !pr.done && ep.chapters[pr.ch] ? pr.ch : 0;
    const at = forced != null ? 0 : pr && !pr.done ? pr.u || 0 : 0;
    if (!quiet) enterPlayerView();
    await gotoChapter(ch, false, at, forced != null && opts.f != null && !isNaN(opts.f) ? opts.f : null);
    if (opts.q) jumpToQuery(opts.q);
    else if (idx > 0 && !quiet) setTimeout(() => mark(idx, true), 50);
    if (autoplay) play();
  }

  function route() {
    const h = location.hash;
    let m = h.match(/^#\/e\/([^?]+)(?:\?(.*))?$/);
    if (m) {
      const q = new URLSearchParams(m[2] || '');
      showEpisode(decodeURIComponent(m[1]), q.get('pl'), q.get('play') === '1', false,
        { ch: q.has('ch') ? parseInt(q.get('ch'), 10) : null, q: q.get('q') || '', f: q.has('f') ? parseFloat(q.get('f')) : null });
      return;
    }
    m = h.match(/^#\/p\/(.+)$/);
    if (m) { showPlaylist(decodeURIComponent(m[1])); return; }
    if (h === '#/library') showLibrary();
    else if (h === '#/search') showSearch();
    else if (h === '#/create') showCreate();
    else showHome();
  }

  /* ---------- keep the app current: a page left open in the background never reloads itself ---------- */
  let appStamp = null;
  const hashText = (t) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return (h >>> 0).toString(16).padStart(8, '0'); };
  async function appVersion(mode) {
    try {
      const r = await fetch('app.js', { cache: mode });
      if (!r.ok) return null;
      return hashText(await r.text());
    } catch (err) { return null; }
  }
  // The browser may hand out an app.js up to 10 minutes old. So the first check compares the newest copy with the copy
  // the page most likely started from (the cached one), instead of with itself.
  async function checkForUpdate() {
    if (appStamp === null) {
      appStamp = await appVersion('force-cache');
      const el = $('app-version'); if (el) el.textContent = 'Version ' + (appStamp || 'unknown');
    }
    const v = await appVersion('no-store');
    if (!v || !appStamp || v === appStamp) return;
    appStamp = v; updatePending = true;
    if (canReloadNow()) { location.reload(); return; }
    showUpdateBar();
  }
  // Never reload under someone who is playing, typing a request, or has a sheet open.
  const canReloadNow = () => !playing && view !== 'create' && !document.querySelector('dialog[open]');
  function showUpdateBar() {
    const bar = $('update-bar'); if (bar) bar.hidden = false;
  }
  async function reloadNow(ev) {
    const btn = (ev && ev.currentTarget) || $('app-reload'); btn.disabled = true; btn.textContent = 'Getting it…';
    try {
      const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update();
      await Promise.all(['index.html', 'app.js', 'style.css', 'library.json', 'audio/manifest.json', 'sw.js'].map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
    } catch (err) { /* reload anyway */ }
    location.reload();
  }
  let updatePending = false;

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
      if (!ep.user && !hasAudio(ep, i)) b.append(mk('small', 'st-' + chapterState(ep, i), ' \u00b7 audio ' + STATE_TEXT[chapterState(ep, i)]));
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
    $('back').addEventListener('click', () => { location.hash = view === 'player' ? (ep && curPl ? '#/p/' + encodeURIComponent(curPl) : lastTab) : '#/library'; });
    $('as-details').addEventListener('click', openAudioDetails);
    $('mini-open').addEventListener('click', () => { if (ep) location.hash = '#/e/' + encodeURIComponent(ep.id) + (curPl ? '?pl=' + encodeURIComponent(curPl) : ''); });
    $('mini-play').addEventListener('click', () => toggle());
    $('mini-next').addEventListener('click', () => { if (ep && chIdx + 1 < ep.chapters.length) gotoChapter(chIdx + 1, playing); });
    document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.tab; store.set('tp.tab', tab); renderLibrary();
    }));
    $('scrubber').addEventListener('input', onScrubInput);
    $('scrubber').addEventListener('change', onScrubCommit);
    $('scrubber').addEventListener('pointerup', () => setTimeout(() => { scrubbing = false; }, 400));
    $('sleep-btn').addEventListener('click', openSleep);
    $('queue-btn').addEventListener('click', openQueue);
    $('queue-open').addEventListener('click', openQueue);
    $('queue-clear').addEventListener('click', () => { queue = []; saveQueue(); updateQueueUi(); openQueue(); });
    $('ver-btn').addEventListener('click', openVersions);
    $('app-reload').addEventListener('click', reloadNow);
    $('update-now').addEventListener('click', reloadNow);
    $('share-app').addEventListener('click', async () => {
      const url = location.href.split('#')[0];
      try { if (navigator.share) { await navigator.share({ title: 'Travel Podcasts', text: 'Our travel podcasts app:', url }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
      try { await navigator.clipboard.writeText(url); showToast('Link copied. Paste it into a message.'); } catch (e) { window.prompt('Copy this link:', url); }
    });
    $('map-gps').addEventListener('click', toggleWalkGps);
    $('map-expand').addEventListener('click', () => openWalkMap());
    $('script-btn').addEventListener('click', () => setScriptShown(!scriptShown, true));
    $('follow-pill').addEventListener('click', resumeFollow);
    $('follow-btn').addEventListener('click', () => setFollow(!settings.follow));
    $('follow').addEventListener('change', (e) => setFollow(e.target.checked));
    window.addEventListener('scroll', () => { clearTimeout(updateFollowPill.t); updateFollowPill.t = setTimeout(updateFollowPill, 250); }, { passive: true });
    ['touchmove', 'wheel'].forEach((t) => window.addEventListener(t, userScrolled, { passive: true }));
    window.addEventListener('keydown', (e) => { if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key) && !/INPUT|TEXTAREA|SELECT|BUTTON/.test((e.target || {}).tagName || '')) userScrolled(); });
    $('map-close').addEventListener('click', closeWalkMap);
    $('dlg-map').addEventListener('close', () => {
      placeWalkView('inline');
      if (mapPushed) { mapPushed = false; if (history.state && history.state.tpMap) history.back(); }
    });
    window.addEventListener('popstate', () => { if ($('dlg-map').open) { mapPushed = false; $('dlg-map').close(); } });
    // every sheet gets a close button at the top, and tapping outside it closes it too
    document.querySelectorAll('dialog').forEach((d) => {
      const sheet = d.querySelector(':scope > form.sheet');
      if (sheet && !sheet.querySelector(':scope > .x')) {
        const x = mk('button', 'icon-btn x', ''); x.type = 'submit'; x.value = 'close'; x.setAttribute('aria-label', 'Close');
        x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        sheet.prepend(x);
      }
      d.addEventListener('click', (ev) => { if (ev.target === d && d.id !== 'dlg-map') d.close(); });
    });
    let st = null;
    $('search-input').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => runSearch(e.target.value), 120); });
    $('arrive-go').addEventListener('click', arriveGo);
    $('walk-go').addEventListener('click', startWalk);
    $('mf-how-more').addEventListener('click', () => { $('mf-how').classList.toggle('open'); syncHowMore(); });
    $('arrive-x').addEventListener('click', () => { arrivePrompt = null; syncArrive(); });
    $('map-save').addEventListener('click', onSaveMap);
    $('report-btn').addEventListener('click', () => openReport(false));
    $('walk-report').addEventListener('click', () => openReport(true));
    $('rp-send').addEventListener('click', sendReport);
    document.getElementsByName('rp-kind').forEach((r) => r.addEventListener('change', syncReportHint));
    const setWait = (on) => {
      settings.waitStop = on; saveSettings(); $('walk-wait').checked = on; $('waitstop').checked = on;
      if (on && walkWatch == null && walkState() && view === 'player') { walkPref.setGps(true); startWalkGps(false); }
      syncArrive();
    };
    $('walk-wait').addEventListener('change', (e) => setWait(e.target.checked));
    $('waitstop').addEventListener('change', (e) => setWait(e.target.checked));
    $('cr-kind').addEventListener('change', () => { syncCreateForm(); $('cr-status').className = 'fine'; $('cr-status').textContent = ''; });
    $('cr-send').addEventListener('click', sendRequest);
    $('cr-refresh').addEventListener('click', loadRequests);
    $('relay-test').addEventListener('click', async () => {
      const out = $('relay-status');
      store.set('tp.relay', { url: $('relay-url').value.trim(), code: $('relay-code').value.trim() });
      if (!relayReady()) { out.textContent = 'Enter both the address and the family code.'; return; }
      out.textContent = 'Testing\u2026';
      try {
        const r = await relayPost({ ping: true });
        out.textContent = r.ok ? 'Connected. The Create tab now has Send to Claude.' : ((r.data && r.data.error) || ('The relay answered ' + r.status + '.'));
      } catch (err) { out.textContent = 'Could not reach that address. Check it for typing mistakes.'; }
      syncCreateForm();
    });
    $('cr-copy').addEventListener('click', async () => {
      const text = buildRequest();
      const out = $('cr-out'); out.value = text; out.hidden = false;
      try { await navigator.clipboard.writeText(text); showToast('Copied. Paste it into your chat with Claude.'); }
      catch (err) { out.focus(); out.select(); showToast('Press and hold the text to copy it.'); }
    });
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
      if (!ep || view !== 'player' || e.target.closest('input,textarea,select,dialog')) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.code === 'ArrowRight') skip(3);
      else if (e.code === 'ArrowLeft') skip(-3);
    });

    // settings
    $('settings-btn').addEventListener('click', () => {
      $('engine').value = engine(); syncPhoneBox();
      $('wake').checked = !!settings.wake; $('autonext').checked = !!settings.autonext; $('follow').checked = !!settings.follow; $('waitstop').checked = !!settings.waitStop; $('pron').value = settings.pron || '';
      $('relay-url').value = relay().url; $('relay-code').value = relay().code; $('relay-status').textContent = relayReady() ? 'Saved on this phone.' : '';
      $('gh-token').value = ghToken(); $('gh-status').textContent = ghToken() ? 'Key saved on this phone.' : 'No key saved. Deleting from GitHub is switched off.';
      renderStorage($('storage'));
      loadVoices(); renderSpeakerVoices(); $('dlg-settings').showModal();
    });
    $('gh-check').addEventListener('click', () => { store.set('tp.gh', { token: $('gh-token').value.trim() }); checkGh(); });
    $('engine').addEventListener('change', (e) => {
      settings.engine = e.target.value; settings.engineChosen = true; saveSettings(); syncPhoneBox();
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
    updateQueueUi();
    window.addEventListener('hashchange', route);
    window.addEventListener('online', syncOnline); window.addEventListener('offline', syncOnline);
    setInterval(() => { if (outbox().length) flushOutbox(); }, 60000);
    setInterval(tickEta, 30000);
    route();
    syncOnline();
    checkForUpdate();
    startAudioWatch();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  init();
})();
