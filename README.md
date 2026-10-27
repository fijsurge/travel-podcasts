# Travel Podcasts

Narrated history episodes you can listen to on the road. The page reads each episode aloud with your phone's own
text-to-speech voices: no server, no accounts, no running costs.

## Use it on a phone
1. Open the site (GitHub Pages URL for this repo).
2. Chrome on Android: menu > **Add to Home screen** (or **Install app**). Safari on iPhone: Share > **Add to Home Screen**.
3. Open an episode once while online; it then works offline.
4. Playback remembers where you stopped. Speed, voice and "keep screen on" are in the app.

Limits of browser speech: some phones pause speech when the screen locks. The app plays a silent track and sets
lock-screen controls to help, and can keep the screen on, but plugging in and leaving the screen on is the safest
setup for a long drive.

## Add an episode
- In the app: **Add an episode**, then paste markdown or choose a `.md` file. Stays on that phone only.
- In the repo (shows on every device): add `episodes/<name>.md`, run `python3 tools/build.py`, commit `library.json`.

Episode format:

```
---
title: The Story of X
place: X
order: 3
blurb: One sentence for the library card.
---

## Notes before you listen (skipped when listening)
## Welcome
## Chapter 1: Title
## Sources consulted (shown, not read aloud)
- [Label](https://example.com)
```

Write for the ear: spoken prose, no tables or footnotes, years placed where they sound natural.

## What the buttons do

| Button | Where it acts | Reversible |
| --- | --- | --- |
| Hide on this phone | Only this phone's list | Yes ("Show hidden episodes") |
| Delete from this phone | Episodes you pasted in yourself | No |
| Delete from GitHub | Deletes `episodes/<id>.md`; the audio job then removes its audio and republishes | Claude can restore it from git history |

"Delete from GitHub" needs a fine-grained token (this repo only, Contents: Read and write) saved in Settings. It is kept in that phone's browser only and is never committed.
