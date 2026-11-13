# Video Autopilot

Researches, produces and publishes short videos to YouTube and Instagram. Claude does the research, scripts,
films (with the `lemo-opuscar` skill) and quality review, on your **Claude Pro subscription** through the Claude Code
CLI — no API key. You approve each finished video in the dashboard; the scheduler posts it.

See [PLAN.md](PLAN.md) for the design.

## Start

```bash
npm install
npm start            # builds the dashboard, then serves everything at http://localhost:4317
```

Development (hot reload): `npm run dev` → dashboard at http://localhost:5173.

Start at login (keeps running in the background): `sh scripts/autostart.sh install`.

## One-time setup (Settings → Setup checks shows what's missing)

1. **Claude login** — the app uses the Claude Code CLI (it finds the copy bundled with Claude Desktop, or one on your PATH).
   Log it in once with your Pro account: run `claude` in Terminal and follow `/login`. Then press **Test Claude**.
2. **Video tools** — `brew install ffmpeg uv`, then press **Install video tools** (downloads the style library and its packages).
3. **YouTube / Instagram** — add your app keys in **Settings → Connections** (step-by-step guide there), then **Channels → Connect**.

Try everything without Claude first: **Settings → Test mode** runs the whole pipeline with sample files and a test-pattern video.

## How it works

```
Project schedule → Research → Script → Video → Check → [You approve] → Schedule → Published → Stats
```

- Each Claude step is a headless `claude -p` run in the video's folder `data/projects/p<project>/v<video>/`; its live
  output streams to the dashboard. Prompts are in [`prompts/`](prompts) — edit them to change behaviour.
- One Claude job runs at a time. When your Pro usage limit is hit, work pauses and resumes automatically after the reset.
- The check step measures length, aspect ratio, audio and loudness for free, then Claude reviews a contact sheet of frames.
  Failures go back to the video step with the problems listed (up to 3 attempts).
- YouTube videos are uploaded ahead of time as private with `publishAt`; Instagram Reels are posted at the scheduled time
  through a temporary Cloudflare link that serves only that one file.

## Layout

```
server/src/   API, pipeline, stages, Claude runner, publishers (YouTube, Instagram), scheduler
web/src/      dashboard (React + Vite + Tailwind)
prompts/      prompt templates for each Claude step
skills/       the lemo-opuscar skill (copied from Claude Desktop)
data/         database, video folders, logs (git-ignored)
```

Tests: `npm test` (connectors against fake YouTube/Instagram servers, scheduling, usage-limit parsing).
