#!/usr/bin/env python3
"""Turn episode chapters into MP3 audio with the free, open-source Kokoro voice model.

Commands
  plan [--out FILE]             list chapters whose audio is missing or out of date, as a GitHub matrix
  chapter EPISODE N             synthesize one chapter -> audio/EPISODE/NN.mp3 and NN.json (sentence timings)
  finalize                      write audio/manifest.json from the files present, drop stale ones

Environment
  KOKORO_MODEL   path to kokoro-v1.0*.onnx   (default models/kokoro-v1.0.int8.onnx)
  KOKORO_VOICES  path to voices-v1.0.bin     (default models/voices-v1.0.bin)
  ONLY_EPISODE   limit `plan` to one episode id
Needs: pip install kokoro-onnx soundfile numpy, and ffmpeg on the PATH.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402  (shared parsing and chapter hashes)

ROOT = build.ROOT
AUDIO = ROOT / "audio"
SENTENCE_GAP = 0.30  # seconds of silence between sentences
TURN_GAP = 0.70      # seconds between paragraphs / speaker turns
MP3_BITRATE = "48k"

# ---------- text preparation ----------
ABBR = re.compile(r"\b(?:Mr|Mrs|Ms|Dr|St|Ste|Mt|Jr|Sr|Prof|vs|etc|No|Fr|Gen|Col|Capt|Sgt|Lt|Ft|approx|c|ca)\.$")
BOUND = re.compile(r"""[.!?]["'”’)\]]?\s+(?=["'“‘(]?[A-Z0-9À-ſ])""")


def split_sentences(par):
    pieces, last = [], 0
    for m in BOUND.finditer(par):
        pieces.append(par[last:m.start() + len(m.group(0).rstrip())])
        last = m.end()
    pieces.append(par[last:])
    merged = []
    for piece in pieces:
        if merged and (ABBR.search(merged[-1]) or len(merged[-1]) < 30):
            merged[-1] += " " + piece
        else:
            merged.append(piece)
    out = []
    for s in merged:
        if len(s) <= 260:
            out.append(s)
            continue
        cur = ""
        for frag in re.split(r"(?<=[,;:])\s+", s):
            if cur and len(cur + " " + frag) > 220:
                out.append(cur)
                cur = frag
            else:
                cur = (cur + " " + frag) if cur else frag
        if cur:
            out.append(cur)
    return out


ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def two_digits(n):
    if n < 20:
        return ONES[n]
    return TENS[n // 10] + ("" if n % 10 == 0 else "-" + ONES[n % 10])


def year_words(y):
    """1695 -> 'sixteen ninety-five', 1900 -> 'nineteen hundred', 2016 -> 'twenty sixteen', 2005 -> 'two thousand five'."""
    if 2000 <= y <= 2009:
        return "two thousand" + ("" if y == 2000 else " " + ONES[y - 2000])
    hi, lo = divmod(y, 100)
    if lo == 0:
        return two_digits(hi) + " hundred"
    return two_digits(hi) + (" oh " + ONES[lo] if lo < 10 else " " + two_digits(lo))


YEAR = re.compile(r"(?<![\d,.$€£])\b(1[0-9]{3}|20[0-9]{2})\b(?![\d,%]|\.\d)")


def prepare(text, pron):
    text = YEAR.sub(lambda m: year_words(int(m.group(1))), text)
    for word, said in pron.items():
        text = re.sub(r"\b" + re.escape(word) + r"\b", said, text)
    return text


def load_pronunciations():
    p = ROOT / "tools" / "pronunciations.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


# ---------- units: (paragraph, speaker, sentence) ----------
def chapter_units(chapter, speakers):
    units = []
    for pi, text in enumerate(chapter["paragraphs"]):
        speaker = None
        m = build.SPEAKER_RE.match(text)
        if m and m.group(1) in speakers:
            speaker, text = m.group(1), text[m.end():]
        for s in split_sentences(text):
            units.append({"p": pi, "speaker": speaker, "text": s})
    return units


def episodes():
    out = []
    for p in sorted((ROOT / "episodes").glob("*.md")):
        if p.name.startswith("_"):
            continue
        ep = build.parse_episode(p.read_text(encoding="utf-8"), p.stem)
        if ep["chapters"]:
            out.append(ep)
    return out


def lang_of(voice):
    return "en-gb" if voice[:1] == "b" else "en-us"


def json_path(ep_id, n):
    return AUDIO / ep_id / f"{n:02d}.json"


# ---------- commands ----------
def cmd_plan(args):
    todo = []
    only = os.environ.get("ONLY_EPISODE")
    for ep in episodes():
        if only and ep["id"] != only:
            continue
        for n, ch in enumerate(ep["chapters"]):
            jp = json_path(ep["id"], n)
            current = None
            if jp.exists():
                try:
                    current = json.loads(jp.read_text(encoding="utf-8")).get("hash")
                except ValueError:
                    pass
            if os.environ.get("FORCE") == "1" or current != ch["hash"] or not jp.with_suffix(".mp3").exists():
                todo.append({"episode": ep["id"], "chapter": n})
    matrix = json.dumps({"include": todo}, separators=(",", ":"))
    print(matrix)
    out = args.out or os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"matrix={matrix}\ncount={len(todo)}\n")


def cmd_chapter(args):
    import numpy as np
    import soundfile as sf
    from kokoro_onnx import Kokoro

    ep = next((e for e in episodes() if e["id"] == args.episode), None)
    if ep is None:
        sys.exit(f"unknown episode {args.episode}")
    ch = ep["chapters"][args.chapter]
    units = chapter_units(ch, ep["speakers"])
    pron = load_pronunciations()
    kokoro = Kokoro(
        os.environ.get("KOKORO_MODEL", str(ROOT / "models" / "kokoro-v1.0.int8.onnx")),
        os.environ.get("KOKORO_VOICES", str(ROOT / "models" / "voices-v1.0.bin")),
    )
    pieces, timings, t, sr = [], [], 0.0, 24000
    prev_p = None
    for i, u in enumerate(units):
        voice = ep["voices"].get(u["speaker"] or "narrator") or ep["voices"]["narrator"]
        samples, sr = kokoro.create(prepare(u["text"], pron), voice=voice, speed=1.0, lang=lang_of(voice))
        gap = 0.0
        if i:
            gap = TURN_GAP if u["p"] != prev_p else SENTENCE_GAP
            pieces.append(np.zeros(int(sr * gap), dtype=np.float32))
            t += gap
        dur = len(samples) / sr
        timings.append({"p": u["p"], "speaker": u["speaker"], "text": u["text"], "t": round(t, 2)})
        pieces.append(samples.astype(np.float32))
        t += dur
        prev_p = u["p"]
        if i % 10 == 0:
            print(f"  {args.episode} ch{args.chapter}: {i + 1}/{len(units)} sentences, {t:.0f}s of audio", flush=True)
    outdir = AUDIO / ep["id"]
    outdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "c.wav"
        sf.write(str(wav), np.concatenate(pieces), sr)
        mp3 = outdir / f"{args.chapter:02d}.mp3"
        try:
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), "-ac", "1", "-b:a", MP3_BITRATE, str(mp3)], check=True)
        except FileNotFoundError:  # no ffmpeg: libsndfile can write MP3 itself
            print("ffmpeg not found, encoding with libsndfile", file=sys.stderr)
            sf.write(str(mp3), np.concatenate(pieces), sr, format="MP3")
    meta = {"hash": ch["hash"], "label": ch["label"], "duration": round(t, 2), "units": timings}
    json_path(ep["id"], args.chapter).write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {mp3} ({mp3.stat().st_size // 1024} KB, {t / 60:.1f} min)")


def cmd_finalize(_args):
    manifest = {"episodes": {}}
    eps = {e["id"]: e for e in episodes()}
    if AUDIO.exists():
        for d in sorted(p for p in AUDIO.iterdir() if p.is_dir()):
            ep = eps.get(d.name)
            if ep is None:  # episode was removed
                for f in d.iterdir():
                    f.unlink()
                d.rmdir()
                continue
            chapters = {}
            for jp in sorted(d.glob("*.json")):
                n = int(jp.stem)
                mp3 = jp.with_suffix(".mp3")
                if n >= len(ep["chapters"]) or not mp3.exists():
                    jp.unlink(missing_ok=True)
                    mp3.unlink(missing_ok=True)
                    continue
                meta = json.loads(jp.read_text(encoding="utf-8"))
                chapters[str(n)] = {"hash": meta["hash"], "duration": meta["duration"], "bytes": mp3.stat().st_size}
            manifest["episodes"][d.name] = {"chapters": chapters}
    AUDIO.mkdir(exist_ok=True)
    (AUDIO / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    n = sum(len(e["chapters"]) for e in manifest["episodes"].values())
    print(f"manifest: {n} chapters with audio")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan"); p.add_argument("--out"); p.set_defaults(fn=cmd_plan)
    p = sub.add_parser("chapter"); p.add_argument("episode"); p.add_argument("chapter", type=int); p.set_defaults(fn=cmd_chapter)
    p = sub.add_parser("finalize"); p.set_defaults(fn=cmd_finalize)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
