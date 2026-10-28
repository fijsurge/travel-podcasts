"""One-off voice comparison (run by .github/workflows/voicetest.yml). Not part of the normal audio build.
  python tools/voicetest.py kokoro   -> samples/voicetest-kokoro.mp3 and the two reference clips in refs/
  python tools/voicetest.py chatter  -> samples/voicetest-chatterbox.mp3 (cloned from the refs) and samples/voicetest-chatterbox-default.mp3
"""
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "samples"
REFS = ROOT / "refs"

SCRIPT = [
    ("A", "Okay, so Brussels. The city of waffles, chocolate, and... bureaucrats. [chuckle]"),
    ("B", "Ha! That's a little unfair. Also correct. [laugh]"),
    ("A", "I'm just saying, nobody puts bureaucrat on the tourist poster."),
    ("B", "Fair. But here's the thing I love. The most famous statue in town is a small boy, relieving himself into a fountain."),
    ("A", "[laugh] No. That's the big attraction?"),
    ("B", "That's the big attraction. People queue for it. And on special occasions, he gets dressed up in a costume."),
    ("A", "Wait. He has a wardrobe?"),
    ("B", "Hundreds of costumes. Maybe more."),
    ("A", "[sigh] Of course he does. Okay, but seriously. How does a muddy little settlement on a river turn into the capital of Europe?"),
    ("B", "Slowly. Very slowly. And with a lot of stubbornness."),
    ("A", "Stubbornness. I can work with that."),
    ("B", "[chuckle] So can the city. Shall we start with the mud?"),
    ("A", "Please. Start with the mud."),
]
REF_TEXT = {
    "A": "The river is called the Senne, and you have to imagine it nothing like a proper river. It is a small, slow stream that used to wander across a wide, wet valley, splitting into channels and making little islands as it went. Not exactly a glamorous start.",
    "B": "The river is called the Senne, and you have to imagine it nothing like a proper river. It is a small, slow stream that used to wander across a wide, wet valley, splitting into channels and making little islands as it went. Not exactly a glamorous start.",
}


def gap(prev, cur):
    if len(cur.split()) <= 5:
        return 0.2
    return 0.45


def to_mp3(samples, sr, name):
    OUT.mkdir(exist_ok=True)
    wav = OUT / (name + ".wav")
    sf.write(str(wav), samples, sr)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), "-ac", "1", "-b:a", "64k", str(OUT / (name + ".mp3"))], check=True)
    wav.unlink()


def kokoro():
    from kokoro_onnx import Kokoro
    k = Kokoro(os.environ["KOKORO_MODEL"], os.environ["KOKORO_VOICES"])
    voices = {"A": ("af_heart", "en-us"), "B": ("bm_george", "en-gb")}
    REFS.mkdir(exist_ok=True)
    for who, (v, lang) in voices.items():
        s, sr = k.create(REF_TEXT[who], voice=v, speed=1.0, lang=lang)
        sf.write(str(REFS / (who + ".wav")), s, sr)
    pieces, sr, prev = [], 24000, ""
    for who, text in SCRIPT:
        clean = text.replace("[chuckle]", "").replace("[laugh]", "").replace("[sigh]", "").strip()
        v, lang = voices[who]
        s, sr = k.create(clean, voice=v, speed=1.0, lang=lang)
        if pieces:
            pieces.append(np.zeros(int(sr * gap(prev, clean)), dtype=np.float32))
        pieces.append(s.astype(np.float32))
        prev = clean
    to_mp3(np.concatenate(pieces), sr, "voicetest-kokoro")


def chatter():
    import torch
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    t0 = time.time()
    model = ChatterboxTurboTTS.from_pretrained(device="cpu")
    print(f"model loaded in {time.time() - t0:.0f}s, sample rate {model.sr}", flush=True)
    for name, refs in (("voicetest-chatterbox", True), ("voicetest-chatterbox-default", False)):
        pieces, prev, audio_s, wall = [], "", 0.0, 0.0
        for who, text in SCRIPT:
            t1 = time.time()
            kw = {"audio_prompt_path": str(REFS / (who + ".wav"))} if refs else {}
            wav = model.generate(text, **kw)
            samples = wav.squeeze().detach().cpu().numpy().astype(np.float32)
            dt = time.time() - t1
            wall += dt
            audio_s += len(samples) / model.sr
            print(f"  {name}: {who} {len(samples) / model.sr:4.1f}s audio in {dt:4.1f}s :: {text[:50]}", flush=True)
            if pieces:
                pieces.append(np.zeros(int(model.sr * gap(prev, text)), dtype=np.float32))
            pieces.append(samples)
            prev = text
        print(f"{name}: {audio_s:.0f}s of audio in {wall:.0f}s (real-time factor {wall / audio_s:.2f})", flush=True)
        to_mp3(np.concatenate(pieces), model.sr, name)


if __name__ == "__main__":
    {"kokoro": kokoro, "chatter": chatter}[sys.argv[1]]()
