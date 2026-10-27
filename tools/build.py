#!/usr/bin/env python3
"""Build library.json from episodes/*.md.

Episode format (see README.md):
  ---
  title: The Story of X
  place: X
  order: 3
  blurb: One sentence shown on the library card.
  ---
  ## Notes before you listen ...      (skipped when listening)
  ## Welcome                          (played)
  ## Chapter 1: Title                 (played)
  ## Sources consulted ...            (shown, not played)

The same rules are implemented in the browser (app.js: parseEpisode) so that
pasted episodes behave identically.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WPM = 150  # words per minute at 1.0x, used only for the duration estimate


def clean(text: str) -> str:
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)  # links -> label
    text = re.sub(r"[*_`]+", "", text)  # emphasis / code marks
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


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
    title = meta.get("title") or slug.replace("-", " ").title()
    return {
        "id": slug,
        "title": title,
        "place": meta.get("place", ""),
        "blurb": meta.get("blurb", ""),
        "order": float(meta.get("order", 999)),
        "words": words,
        "minutes": max(1, round(words / WPM)),
        "notes": notes,
        "chapters": chapters,
        "sources": sources,
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
