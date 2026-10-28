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
    searchIdx = null;
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

  function openAudioDetails() {
    const box = $('as-list'); box.textContent = '';
    library.filter((e) => !e.user).forEach((e) => {
      const sm = episodeAudioSummary(e);
      const h = mk('h3', '', e.title); box.append(h);
      const ul = mk('ul', 'as-rows', '');
      e.chapters.forEach((c, n) => {
        const st = chapterState(e, n);
        const li = mk('li', 'as-row ' + (st === 'ready' ? 'ready' : st), '');
        li.append(mk('span', 'dot', ''), mk('span', 'as-label', c.label), mk('small', '', st === 'ready' ? 'ready' : STATE_TEXT[st]));
        ul.append(li);
      });
      box.append(ul);
    });
    const when = audioStatus.at ? new Date(audioStatus.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'not yet';
    $('as-updated').textContent = 'Last checked ' + when + '. This page checks again by itself.';
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
    const fam = family(e);
    b.append(wrap, mk('span', 't-title', e.title), mk('span', 't-meta', `${e.minutes} min · ${variantOf(e)}${fam.length > 1 ? ' · 2 versions' : ''}${note ? ' · ' + note : ''}`));
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
    return pts.slice(0, chs.length).map((pt, k) => ({ lat: pt[0], lon: pt[1], ch: chs[k] }));
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
    renderNear(box);
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
    body.append(mk('span', 'place', removed ? 'Removed' : where + (nowPlaying ? ' · now ' + (playing ? 'playing' : 'open') : '')));
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
      'Please write a new Travel Podcasts episode and add it to the travel-podcasts repo, in the same format as the existing episodes (front matter with title, place, order, blurb, speakers, voices and format, then a Welcome and numbered Chapters, then Sources consulted).',
      '',
      `Format: ${FORMATS[kind].label} (format: ${kind}), ${spec}.`,
      `Place: ${place || '(not given)'}`,
    ];
    const stops = $('cr-stops').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (kind === 'walk' && stops.length) { lines.push('Stops, in order:'); stops.forEach((x, i) => lines.push(`${i + 1}. ${x}`)); }
    if ($('cr-time').value.trim()) lines.push('Time available: ' + $('cr-time').value.trim());
    if ($('cr-interests').value.trim()) lines.push('What we care about: ' + $('cr-interests').value.trim());
    lines.push('Style: ' + $('cr-style').value + '.');
    if ($('cr-notes').value.trim()) lines.push('Practical notes: ' + $('cr-notes').value.trim());
    lines.push('', 'Research the facts on the web, keep to what the sources support, and list them under Sources consulted. Write years as numerals, except three-digit years, which are spelled out in words. Push it to main so the audio is built automatically, and tell me when it is ready.');
    return lines.join('\n');
  }
  function syncCreateForm() { $('cr-stops-wrap').hidden = $('cr-kind').value !== 'walk'; }

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
    if (document.visibilityState === 'visible') { if (updatePending && !playing) location.reload(); else checkForUpdate(); if (needsAudio() || audioStatus.active) scheduleAudioPoll(500); }
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
    const p = audioEl.play();
    if (p && p.catch) p.catch((err) => { if (!err || err.name !== 'AbortError') { playing = false; setPlayingUi(); unlockScreen(); showToast('Tap play to carry on.'); } });
    loadSeq++; chIdx = n; idx = 0; pendingSeek = null;
    renderChapter({ units: data.units, audio: true });
    mark(0, true); remember(false);
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
    drawHero();
    updateScrub(true);
    $('ch-meta').textContent = `${chIdx + 1} of ${ep.chapters.length} · ${mode === 'audio' ? 'natural voice' : naturalOnly(ep) ? 'audio ' + STATE_TEXT[chapterState(ep, chIdx)] : 'phone voice'}`;
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
    if (scroll && spans[i]) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      spans[i].scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }
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
    updateMini();
    $('ico-play').toggleAttribute('hidden', playing);
    $('ico-pause').toggleAttribute('hidden', !playing);
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
  async function appVersion() {
    try {
      const r = await fetch('app.js', { cache: 'no-store' });
      if (!r.ok) return null;
      const t = await r.text();
      let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
      return t.length + ':' + h;
    } catch (err) { return null; }
  }
  async function checkForUpdate() {
    const v = await appVersion();
    if (!v) return;
    if (appStamp === null) { appStamp = v; return; }
    if (v === appStamp) return;
    if (!playing) { location.reload(); return; }
    showToast('A new version is ready. It will load when you pause or reopen the app.');
    appStamp = v; updatePending = true;
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
    let st = null;
    $('search-input').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => runSearch(e.target.value), 120); });
    $('cr-kind').addEventListener('change', syncCreateForm);
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
      $('wake').checked = !!settings.wake; $('autonext').checked = !!settings.autonext; $('pron').value = settings.pron || '';
      $('gh-token').value = ghToken(); $('gh-status').textContent = ghToken() ? 'Key saved on this phone.' : 'No key saved. Deleting from GitHub is switched off.';
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
    route();
    checkForUpdate();
    startAudioWatch();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  init();
})();
