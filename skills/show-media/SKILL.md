---
name: show-media
description: >
  Show images and video inline in pi-desktop chat. Use whenever the user
  wants to SEE something — reference photos, diagrams, video frames,
  screenshots, or playable clips — instead of just reading about it.
  The desktop app renders markdown media embeds as real pictures and a
  native video player. (In a plain terminal the same markdown shows as
  source text, harmlessly.)
---

# Show Media

The pi-desktop app renders media you embed in your reply. You figure out
*how* to get the pixels; the app handles display. Always embed the media
itself — never just describe it or drop a bare link when the user asked
to see it.

## Syntax

```markdown
![caption shown under the media](SOURCE)
```

Image or video is decided by file extension:

- **Image** (`png jpg jpeg gif webp bmp svg ico avif`) → inline picture,
  click to open full-size.
- **Video** (`mp4 webm mov ogv m4v`) → a playable card. First click
  plays it inline; an `open in player ↗` button hands it to your system
  player. (Cards exist because a `<video>` element is only ever created
  on click — never at render time, which kills the renderer on machines
  with broken GStreamer.)
- A bare `https://…/file.jpg` (or `.mp4`) **alone on its own line**
  also embeds. Mid-sentence URLs stay plain links.
- Raw `<img src="…">` / `<video src="…">` HTML works too (sanitized
  down to `src` + `alt` + size/playback attributes).

The `alt` text becomes the visible caption — always write a real one.

## Sources

- **Web:** any `https://` URL. Prefer direct file URLs (ending in the
  extension). Hotlinking is fine for reference material.
- **Local files:** absolute paths (`/home/you/vids/shot_01.png`) or paths
  relative to the session working directory (`./shots/f1.png`). The app
  resolves them — always prefer saving into the session cwd (e.g.
  `./shots/`) with relative embeds so the transcript stays portable.
- **`data:image/` / `data:video/` URIs** work but bloat the session file —
  prefer real files.

## Video frames (the common case)

To show a moment from a video, grab frames with ffmpeg into the cwd and
embed them. Downscale so they load fast:

```bash
mkdir -p ./shots
# one frame at 1m23s, max 1280px wide
ffmpeg -hide_banner -loglevel error -ss 00:01:23 -i clip.mp4 \
  -vframes 1 -vf 'scale=1280:-1' ./shots/f01.png
# a contact strip: one frame every 10s
ffmpeg -hide_banner -loglevel error -i clip.mp4 -vf 'fps=1/10,scale=640:-1' ./shots/s_%03d.jpg
```

Then:

```markdown
![hallway fight, 01:23](./shots/f01.png)
```

To show motion, embed a short trimmed clip instead (keep it seconds-long).
The card plays it inline on first click, with `open in player ↗` beside it:

```markdown
![the stunt, 01:20–01:25](./shots/moment.mp4)
```

## Thumbnails for video (explicit, no filename coupling)

A clip with a poster frame uses standard linked-image markdown — the
thumbnail first, the clip as the link target:

```markdown
[![the stunt, 01:20–01:25](./shots/moment.jpg)](./shots/moment.mp4)
```

Save both files (poster = one frame grab):

```bash
ffmpeg -hide_banner -loglevel error -ss 00:01:20 -i clip.mp4 -t 5 -c copy ./shots/moment.mp4
ffmpeg -hide_banner -loglevel error -ss 00:01:21 -i clip.mp4 -vframes 1 -vf 'scale=1280:-1' ./shots/moment.jpg
```

The card shows the poster with a play overlay; click plays inline.
No poster (plain `![cap](clip.mp4)`) renders the same card without a
thumbnail — always valid, just less pretty. Linked non-video targets
(`[![diagram](./shots/d.png)](https://docs/…)`) render as clickable
images.

## Rules

1. Embed first, link second. If the user asked to *see* it, the reply
   must contain `![…](…)` embeds, not just URLs.
2. Keep files small: downscale images (`scale=1280:-1`), trim clips to
   the interesting seconds. Never paste megabytes of base64 into chat.
3. The app allowlists `https/http`, `data:image|video`, and local paths
   only. `javascript:` / `data:text/html` and unknown schemes are
   refused — don't use them.
4. If a file might not exist (bad path, failed ffmpeg), say what you
   tried — the app shows a "could not load media" fallback, never a
   silent blank.
