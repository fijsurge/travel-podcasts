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
    { rate: 1, voiceURI: '', wake: true, autonext: true, pron: '' },
    store.get('tp.settings', {})
  );
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
      notes, chapters, sources,
    };
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

  function buildUnits(chapter) {
    const units = [];
    chapter.paragraphs.forEach((p, pi) => splitSentences(p).forEach((t) => units.push({ p: pi, text: t })));
    return units;
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

  function renderLibrary() {
    const ul = $('cards');
    ul.textContent = '';
    if (!library.length) {
      const li = document.createElement('li');
      li.className = 'fine';
      li.textContent = 'No episodes yet. Add one below.';
      ul.append(li);
    }
    library.forEach((ep) => {
      const li = document.createElement('li');
      li.className = 'card';
      const pct = percent(ep);
      const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; return e; };
      li.append(mk('span', 'place', ep.place || (ep.user ? 'Added by you' : 'Episode')));
      li.append(mk('h2', '', ep.title));
      if (ep.blurb) li.append(mk('p', '', ep.blurb));
      li.append(mk('div', 'meta', `${ep.chapters.length} parts · about ${ep.minutes} min${pct ? ' · ' + (pct >= 100 ? 'finished' : pct + '% heard') : ''}`));
      if (pct > 0 && pct < 100) {
        const bar = mk('div', 'progress', ''); const fill = document.createElement('div'); fill.style.width = pct + '%'; bar.append(fill); li.append(bar);
      }
      const actions = mk('div', 'actions', '');
      const go = mk('button', 'primary', pct > 0 && pct < 100 ? 'Resume' : pct >= 100 ? 'Listen again' : 'Listen');
      go.addEventListener('click', () => {
        if (pct >= 100) { delete progress[ep.id]; saveProgress(); }
        location.hash = '#/e/' + encodeURIComponent(ep.id);
      });
      actions.append(go);
      if (ep.user) {
        const del = mk('button', 'del', 'Remove');
        del.addEventListener('click', () => {
          if (!confirm('Remove "' + ep.title + '" from this phone?')) return;
          userEps = userEps.filter((e) => e.id !== ep.id); store.set('tp.user', userEps);
          delete progress[ep.id]; saveProgress();
          loadLibrary().then(renderLibrary);
        });
        actions.append(del);
      }
      li.append(actions);
      ul.append(li);
    });
  }

  /* ---------- player state ---------- */
  let ep = null, chIdx = 0, units = [], spans = [], idx = 0;
  let playing = false, token = 0, lastStart = 0, watchdog = null;

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
    set('seekbackward', () => skip(-3));
    set('seekforward', () => skip(3));
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

  /* ---------- rendering the reader ---------- */
  function showToast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(showToast.h); showToast.h = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function renderChapter() {
    const ch = ep.chapters[chIdx];
    units = buildUnits(ch);
    const reader = $('reader');
    reader.textContent = '';
    const h = document.createElement('h2'); h.textContent = ch.label; reader.append(h);
    spans = [];
    let pi = -1, p = null;
    units.forEach((u, i) => {
      if (u.p !== pi) { p = document.createElement('p'); reader.append(p); pi = u.p; }
      const s = document.createElement('span');
      s.className = 's'; s.dataset.i = String(i); s.textContent = u.text;
      p.append(s, document.createTextNode(' '));
      spans.push(s);
    });
    $('ch-label').textContent = ch.label;
    $('ch-meta').textContent = `${chIdx + 1} of ${ep.chapters.length}`;
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
    $('bar-fill').style.width = (units.length ? Math.round((i / units.length) * 100) : 0) + '%';
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

  /* ---------- speech engine ---------- */
  function speakUnit(i, my) {
    if (my !== token || !playing) return;
    if (i >= units.length) { chapterDone(); return; }
    idx = i; mark(i, true); remember(false);
    const u = new SpeechSynthesisUtterance(pronounce(units[i].text));
    const v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en';
    u.rate = settings.rate;
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

  function play() { if (ep) start(Math.min(idx, Math.max(0, units.length - 1))); }
  function pause() {
    playing = false; token++; clearInterval(watchdog);
    if (synth) synth.cancel();
    setPlayingUi(); stopKeepAlive(); unlockScreen(); remember(false);
  }
  function toggle() { playing ? pause() : play(); }

  function skip(n) {
    const i = Math.min(Math.max(0, idx + n), Math.max(0, units.length - 1));
    idx = i; mark(i, true); remember(false);
    if (playing) start(i);
  }

  function gotoChapter(n, keepPlaying, at) {
    if (n < 0) n = 0;
    if (n >= ep.chapters.length) { return; }
    const wasPlaying = keepPlaying;
    if (playing) { token++; if (synth) synth.cancel(); }
    chIdx = n; idx = at || 0;
    renderChapter(); mark(idx, false);
    window.scrollTo({ top: 0 });
    remember(false);
    if (wasPlaying) start(idx); else { playing = false; setPlayingUi(); }
  }

  function chapterDone() {
    if (settings.autonext && chIdx + 1 < ep.chapters.length) { gotoChapter(chIdx + 1, true); return; }
    const last = chIdx + 1 >= ep.chapters.length;
    playing = false; token++; clearInterval(watchdog); setPlayingUi(); stopKeepAlive(); unlockScreen();
    if (last) { remember(true); showToast('Episode finished.'); }
    else { chIdx += 1; idx = 0; renderChapter(); mark(0, false); remember(false); }
  }

  /* ---------- views and routing ---------- */
  function showLibrary() {
    if (playing) pause();
    ep = null;
    $('view-library').hidden = false; $('view-player').hidden = true; $('transport').hidden = true;
    $('back').hidden = true; $('title').textContent = 'Travel Podcasts';
    document.title = 'Travel Podcasts';
    renderLibrary();
  }

  function showEpisode(id) {
    const found = library.find((e) => e.id === id);
    if (!found) { location.hash = ''; return; }
    if (ep && ep.id === id) return;
    if (playing) pause();
    ep = found;
    const pr = progress[ep.id];
    const ch = pr && !pr.done && ep.chapters[pr.ch] ? pr.ch : 0;
    chIdx = ch; idx = pr && !pr.done ? pr.u || 0 : 0;
    $('view-library').hidden = true; $('view-player').hidden = false; $('transport').hidden = false;
    $('back').hidden = false; $('title').textContent = ep.title; document.title = ep.title + ' · Travel Podcasts';
    renderChapter();
    idx = Math.min(idx, Math.max(0, units.length - 1));
    mark(idx, false);
    if (idx > 0) setTimeout(() => mark(idx, true), 50);
    setPlayingUi();
  }

  function route() {
    const m = location.hash.match(/^#\/e\/(.+)$/);
    if (m) showEpisode(decodeURIComponent(m[1])); else showLibrary();
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
        if (playing) start(idx);
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

  function wire() {
    $('back').addEventListener('click', () => { location.hash = ''; });
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
      idx = i; mark(i, false); start(i);
    });
    document.addEventListener('keydown', (e) => {
      if (!ep || e.target.closest('input,textarea,select,dialog')) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.code === 'ArrowRight') skip(3);
      else if (e.code === 'ArrowLeft') skip(-3);
    });

    // settings
    $('settings-btn').addEventListener('click', () => {
      $('wake').checked = !!settings.wake; $('autonext').checked = !!settings.autonext; $('pron').value = settings.pron || '';
      loadVoices(); $('dlg-settings').showModal();
    });
    $('voice').addEventListener('change', (e) => { settings.voiceURI = e.target.value; saveSettings(); if (playing) start(idx); });
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
