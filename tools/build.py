#!/usr/bin/env python3
"""Build library.json from episodes/*.md.

Episode format (see README.md):
  ---
  title: The Story of X
  place: X
  order: 3
  blurb: One sentence shown on the library card.
  format: overview (10 to 15 min briefing), walk (stop-by-stop walking tour) or deep (long deep dive). Default deep.
  series: optional name that groups variants of the same topic.
  speakers: Anna, Ben                 (optional, for two-voice dialogue episodes)
  stops: lat,lon; lat,lon             (optional, one per Stop/Chapter section: shows the walking map)
  hints: how to reach stop 1 | stop 2 | ...   (optional, one short line per stop)
  maps: Het Steen, Antwerp | Grote Markt, Antwerp | ...   (optional, one Google Maps search per stop: the landmark's name and city, so Directions go to the place itself)
  placeids: Google Place ID per stop, | separated (optional; Maps then shows the place by name)
  engine: chatterbox                  (optional voice engine: kokoro (default) or chatterbox)
  ---
  ## Notes before you listen ...      (skipped when listening)
  ## Welcome                          (played)
  ## Chapter 1: Title                 (played)
  ## Sources consulted ...            (shown, not played)

The same rules are implemented in the browser (app.js: parseEpisode) so that
pasted episodes behave identically.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WPM = 150  # words per minute at 1.0x, used only for the duration estimate
GEN_VERSION = "1"  # bump to force every chapter's audio to be regenerated
ENGINES = ("kokoro", "chatterbox")  # front matter: engine: chatterbox (default kokoro)
DEFAULT_NARRATOR_VOICE = "bf_emma"
DEFAULT_VOICES = ["af_heart", "bm_george", "af_sarah", "am_michael"]  # used for speakers in order


def clean(text: str) -> str:
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)  # links -> label
    text = re.sub(r"[*_`]+", "", text)  # emphasis / code marks
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


SPEAKER_RE = re.compile(r"^([A-Z\u00C0-\u00DD][A-Za-z\u00C0-\u00FF'\u2019-]{0,19}(?: [A-Z\u00C0-\u00DD][A-Za-z\u00C0-\u00FF'\u2019-]{0,19})?): ")


def detect_speakers(meta, chapters):
    """Dialogue episodes: a paragraph starting "Name: " is spoken by that speaker.
    Declared in front matter (speakers: Anna, Ben) or auto-detected when two or more
    names each open at least two paragraphs. Same rule as app.js."""
    if meta.get("speakers"):
        return [s.strip() for s in meta["speakers"].split(",") if s.strip()]
    counts = {}
    for c in chapters:
        for p in c["paragraphs"]:
            m = SPEAKER_RE.match(p)
            if m:
                counts[m.group(1)] = counts.get(m.group(1), 0) + 1
    names = [n for n, k in counts.items() if k >= 2]
    return names if len(names) >= 2 else []


def parse_voices(meta, speakers):
    """voices: Anna=af_heart, Ben=bm_george, narrator=bf_emma (all optional)."""
    voices = {"narrator": DEFAULT_NARRATOR_VOICE}
    for i, name in enumerate(speakers):
        voices[name] = DEFAULT_VOICES[i % len(DEFAULT_VOICES)]
    for part in meta.get("voices", "").split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            voices[k.strip()] = v.strip()
    return voices


# Speech rules that change how text is read aloud. A chapter's hash includes whatever these rules touch in
# that chapter, so changing a rule remakes only the chapters it affects (not every episode).
YEAR_BEFORE_COMMA = re.compile(r"(?<![\d.$\u20ac\u00a3])(?<!\d,)\b(1[0-9]{3}|20[0-9]{2}),(?!\d)")


DECADE_OR_RANGE = re.compile(r"\b(?:1[0-9]{2}0|20[0-9]0)s\b|\b(?:1[0-9]{3}|20[0-9]{2})\s?[-\u2013]\s?(?:1[0-9]{3}|20[0-9]{2})\b|\b1000\b|\b[1-9]00s\b")


def load_pronunciations():
    p = ROOT / "tools" / "pronunciations.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def speech_fixups(paragraphs):
    text = "\n".join(paragraphs)
    found = ["yc:" + m.group(1) for m in YEAR_BEFORE_COMMA.finditer(text)]
    found += ["dr:" + m.group(0) for m in DECADE_OR_RANGE.finditer(text)]
    for word, said in sorted(load_pronunciations().items()):
        if re.search(r"\b" + re.escape(word) + r"\b", text):
            found.append(f"pr:{word}={said}")
    return found


def chapter_hash(paragraphs, speakers, voices, engine="kokoro"):
    """Identifies the exact text and voices a chapter's audio was made from."""
    parts = [paragraphs, speakers, voices, GEN_VERSION]
    if engine != "kokoro":  # only for other engines, so existing Kokoro chapters keep their hash
        parts.append(["engine", engine])
    fx = speech_fixups(paragraphs)
    if fx:  # only when a rule applies, so untouched chapters keep their existing hash
        parts.append(fx)
    blob = json.dumps(parts, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _stops(v):
    """'lat,lon; lat,lon' -> [[lat, lon], ...] (one per Stop/Chapter section, in order)."""
    out = []
    for part in (v or "").split(";"):
        bits = [b.strip() for b in part.split(",")]
        if len(bits) == 2 and _num(bits[0]) is not None and _num(bits[1]) is not None:
            out.append([float(bits[0]), float(bits[1])])
    return out


def parse_front(raw: str):
    meta = {}
    m = re.match(r"^---\n(.*?)\n---\n", raw, re.S)
    body = raw
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
        body = raw[m.end():]
    return meta, body


def parse_episode(raw: str, slug: str):
    meta, body = parse_front(raw)
    sections = re.split(r"^## +", body, flags=re.M)[1:]
    chapters, sources, notes = [], [], ""
    for sec in sections:
        head, _, rest = sec.partition("\n")
        head = clean(head)
        low = head.lower()
        if low.startswith("notes before"):
            notes = clean(rest)
            continue
        if low.startswith("sources"):
            for line in rest.splitlines():
                m = re.match(r"^\s*[-*]\s*\[(.+?)\]\((.+?)\)", line)
                if m:
                    sources.append({"title": clean(m.group(1)), "url": m.group(2)})
            continue
        paras = [clean(p) for p in re.split(r"\n\s*\n", rest) if clean(p)]
        paras = [re.sub(r"\s*\n\s*", " ", p) for p in paras]
        if not paras:
            continue
        chapters.append({"title": re.sub(r"^Chapter\s+\d+:\s*", "", head), "label": head, "paragraphs": paras})
    words = sum(len(p.split()) for c in chapters for p in c["paragraphs"])
    speakers = detect_speakers(meta, chapters)
    voices = parse_voices(meta, speakers)
    engine = (meta.get("engine") or "kokoro").strip().lower()
    if engine not in ENGINES:
        raise SystemExit(f"{slug}: unknown engine '{engine}' (use one of {', '.join(ENGINES)})")
    for c in chapters:
        c["hash"] = chapter_hash(c["paragraphs"], speakers, voices, engine)
    title = meta.get("title") or slug.replace("-", " ").title()
    return {
        "id": slug,
        "title": title,
        "place": meta.get("place", ""),
        "format": meta.get("format", "deep"),  # overview | walk | deep
        "series": meta.get("series", ""),
        "blurb": meta.get("blurb", ""),
        "lat": _num(meta.get("lat")),
        "lon": _num(meta.get("lon")),
        "stops": _stops(meta.get("stops", "")),
        "hints": [h.strip() for h in meta.get("hints", "").split("|") if h.strip()],
        "maps": [h.strip() for h in meta.get("maps", "").split("|") if h.strip()],
        "placeIds": [h.strip() for h in meta.get("placeids", "").split("|")] if meta.get("placeids", "").strip() else [],
        "order": float(meta.get("order", 999)),
        "words": words,
        "minutes": max(1, round(words / WPM)),
        "notes": notes,
        "chapters": chapters,
        "sources": sources,
        "speakers": speakers,
        "voices": voices,
        "engine": engine,
    }


def main():
    eps = []
    for p in sorted((ROOT / "episodes").glob("*.md")):
        if p.name.startswith("_"):
            continue
        ep = parse_episode(p.read_text(encoding="utf-8"), p.stem)
        if not ep["chapters"]:
            print(f"warning: {p.name} has no chapters", file=sys.stderr)
            continue
        eps.append(ep)
    eps.sort(key=lambda e: (e["order"], e["title"]))
    out = ROOT / "library.json"
    out.write_text(json.dumps({"episodes": eps}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for e in eps:
        print(f"{e['id']}: {len(e['chapters'])} chapters, ~{e['minutes']} min, {len(e['sources'])} sources")
    print(f"wrote {out.name} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
