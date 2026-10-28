#!/usr/bin/env python3
"""Turn episode chapters into MP3 audio with the free, open-source Kokoro voice model.

Commands
  plan [--out FILE]             list chapters whose audio is missing or out of date, as a GitHub matrix
  chapter EPISODE N             synthesize one chapter -> audio/EPISODE/NN.mp3 and NN.json (sentence timings)
  refs                          make the reference voice clips (refs/anna.wav, refs/ben.wav) that Chatterbox clones
  finalize                      write audio/manifest.json from the files present, drop stale ones

Environment
  KOKORO_MODEL   path to kokoro-v1.0*.onnx   (default models/kokoro-v1.0.int8.onnx)
  KOKORO_VOICES  path to voices-v1.0.bin     (default models/voices-v1.0.bin)
  ONLY_EPISODE   limit `plan` to one episode id
Engines (front matter `engine:`)
  kokoro      default. Needs: pip install kokoro-onnx soundfile numpy, and ffmpeg on the PATH.
  chatterbox  more expressive two-host dialogue. Needs: pip install chatterbox-tts soundfile (Python 3.11), ffmpeg,
              and refs/<speaker>.wav (run `refs` once). Speakers are cloned from those clips.
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
TURN_GAP = 0.70      # seconds between paragraphs in a single-narrator episode
MP3_BITRATE = "48k"

# ---------- text preparation ----------
# (touching this file re-runs the audio job, which fills in any chapter whose audio is missing)
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
    if y == 1000:
        return "one thousand"
    if lo == 0:
        return two_digits(hi) + " hundred"
    return two_digits(hi) + (" oh " + ONES[lo] if lo < 10 else " " + two_digits(lo))


YEAR = re.compile(r"(?<![\d.$€£])(?<!\d,)\b(1[0-9]{3}|20[0-9]{2})\b(?!\d|,\d|%|\.\d)")


def plural_tens(word):
    """sixty -> sixties, ten -> tens, hundred -> hundreds"""
    return word[:-1] + "ies" if word.endswith("y") else word + "s"


DECADE = re.compile(r"(?<![\d.$€£])\b(1[0-9]{2}0|20[0-9]0)s\b")
YEAR_RANGE = re.compile(r"(?<![\d.$€£])\b(1[0-9]{3}|20[0-9]{2})\s?[-\u2013]\s?(1[0-9]{3}|20[0-9]{2})\b(?!\d)")


def decade_words(n):
    """1960 -> 'nineteen sixties', 1900 -> 'nineteen hundreds', 2000 -> 'two thousands'."""
    if n == 2000:
        return "two thousands"
    hi, lo = divmod(n, 100)
    return two_digits(hi) + " " + (plural_tens(two_digits(lo)) if lo else "hundreds")


HUNDREDS = re.compile(r"(?<![\d.$€£])\b([1-9])00s\b")


# Delivery tags such as [laugh] are performed by Chatterbox and silently dropped by Kokoro.
TAG = re.compile(r"\s*\[(?:laugh|chuckle|sigh|cough|gasp|groan|sniff|shush|clear throat)\]\s*", re.I)


def strip_tags(text):
    return re.sub(r"\s{2,}", " ", TAG.sub(" ", text)).strip()


def prepare(text, pron, keep_tags=False):
    if not keep_tags:
        text = strip_tags(text)
    text = HUNDREDS.sub(lambda m: ONES[int(m.group(1))] + " hundreds", text)
    text = YEAR_RANGE.sub(lambda m: m.group(1) + " to " + m.group(2), text)
    text = DECADE.sub(lambda m: decade_words(int(m.group(1))), text)
    text = YEAR.sub(lambda m: year_words(int(m.group(1))), text)
    for word, said in pron.items():
        text = re.sub(r"\b" + re.escape(word) + r"\b", said, text)
    return text


load_pronunciations = build.load_pronunciations


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


def para_words(ch, speakers):
    out = []
    for text in ch["paragraphs"]:
        m = build.SPEAKER_RE.match(text)
        if m and m.group(1) in speakers:
            text = text[m.end():]
        out.append(len(text.split()))
    return out


def turn_gap(speakers, prev_unit, unit, words):
    """Pause before a new paragraph. Single narrators keep a steady pause; hosts get a conversational rhythm:
    quick back-and-forth around short reactions, a beat after a question, a fuller pause otherwise."""
    if not speakers:
        return TURN_GAP
    if words[unit["p"]] <= 4:
        return 0.18          # a short reaction ("Right." "Ha.")
    if words[prev_unit["p"]] <= 4:
        return 0.28          # the answer after a reaction
    if prev_unit["text"].rstrip().endswith("?"):
        return 0.38
    return 0.55


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
                todo.append({"episode": ep["id"], "chapter": n, "engine": ep["engine"]})
    matrix = json.dumps({"include": todo}, separators=(",", ":"))
    print(matrix)
    out = args.out or os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"matrix={matrix}\ncount={len(todo)}\n")


# ---------- engines: each returns (float32 samples, sample rate) for one sentence ----------
def kokoro_engine(ep):
    from kokoro_onnx import Kokoro
    kokoro = Kokoro(
        os.environ.get("KOKORO_MODEL", str(ROOT / "models" / "kokoro-v1.0.int8.onnx")),
        os.environ.get("KOKORO_VOICES", str(ROOT / "models" / "voices-v1.0.bin")),
    )

    def say(text, speaker):
        voice = ep["voices"].get(speaker or "narrator") or ep["voices"]["narrator"]
        samples, sr = kokoro.create(prepare(text, PRON), voice=voice, speed=1.0, lang=lang_of(voice))
        return samples.astype("float32"), sr

    return say


def ref_path(speaker):
    return ROOT / "refs" / ((speaker or "narrator").lower() + ".wav")


def tidy(samples, sr, text):
    """Chatterbox can leave silence around a sentence, and very short lines sometimes trail off into noise.
    Trim the silence and cap the length to what the words could plausibly take, so pacing stays ours."""
    import numpy as np
    a = np.abs(samples)
    loud = np.where(a > max(0.012, float(a.max()) * 0.02))[0]
    if len(loud):
        pad = int(sr * 0.04)
        samples = samples[max(0, loud[0] - pad): loud[-1] + pad]
    cap = int(sr * max(1.6, 0.8 + 0.62 * len(text.split())))
    if len(samples) > cap:
        samples = samples[:cap].copy()
        fade = int(sr * 0.12)
        samples[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=samples.dtype)
    return samples


def chatterbox_engine(ep):
    import torch
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    torch.manual_seed(1234)
    model = ChatterboxTurboTTS.from_pretrained(device="cpu")
    print(f"chatterbox loaded, sample rate {model.sr}", flush=True)

    def say(text, speaker):
        ref = ref_path(speaker)
        if not ref.exists():
            sys.exit(f"missing reference voice {ref.relative_to(ROOT)} (run: make_audio.py refs)")
        wav = model.generate(prepare(text, PRON, keep_tags=True), audio_prompt_path=str(ref))
        samples = wav.squeeze().detach().cpu().numpy().astype("float32")
        return tidy(samples, model.sr, strip_tags(text)), model.sr

    return say


ENGINE_FACTORIES = {"kokoro": kokoro_engine, "chatterbox": chatterbox_engine}
PRON = {}


def cmd_chapter(args):
    import numpy as np
    import soundfile as sf

    ep = next((e for e in episodes() if e["id"] == args.episode), None)
    if ep is None:
        sys.exit(f"unknown episode {args.episode}")
    ch = ep["chapters"][args.chapter]
    units = chapter_units(ch, ep["speakers"])
    PRON.update(load_pronunciations())
    say = ENGINE_FACTORIES[ep["engine"]](ep)
    pieces, timings, t, sr = [], [], 0.0, 24000
    prev_p = None
    words = para_words(ch, ep["speakers"])
    for i, u in enumerate(units):
        samples, sr = say(u["text"], u["speaker"])
        gap = 0.0
        if i:
            gap = turn_gap(ep["speakers"], units[i - 1], u, words) if u["p"] != prev_p else SENTENCE_GAP
            pieces.append(np.zeros(int(sr * gap), dtype=np.float32))
            t += gap
        dur = len(samples) / sr
        timings.append({"p": u["p"], "speaker": u["speaker"], "text": strip_tags(u["text"]), "t": round(t, 2)})
        pieces.append(samples)
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


REF_TEXT = ("The river is called the Senne, and you have to imagine it nothing like a proper river. It is a small, slow "
            "stream that used to wander across a wide, wet valley, splitting into channels and making little islands "
            "as it went. Not exactly a glamorous start.")
REF_VOICES = {"anna": "af_heart", "ben": "bm_george"}


def cmd_refs(_args):
    """Kokoro reads one short passage in each host voice; Chatterbox then clones those clips."""
    import soundfile as sf
    from kokoro_onnx import Kokoro
    kokoro = Kokoro(
        os.environ.get("KOKORO_MODEL", str(ROOT / "models" / "kokoro-v1.0.int8.onnx")),
        os.environ.get("KOKORO_VOICES", str(ROOT / "models" / "voices-v1.0.bin")),
    )
    (ROOT / "refs").mkdir(exist_ok=True)
    for who, voice in REF_VOICES.items():
        samples, sr = kokoro.create(REF_TEXT, voice=voice, speed=1.0, lang=lang_of(voice))
        sf.write(str(ROOT / "refs" / f"{who}.wav"), samples, sr)
        print(f"refs/{who}.wav  {len(samples) / sr:.1f}s")


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
    p = sub.add_parser("refs"); p.set_defaults(fn=cmd_refs)
    p = sub.add_parser("finalize"); p.set_defaults(fn=cmd_finalize)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
