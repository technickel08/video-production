# Video Autopilot — Plan

A local app that **researches, produces and publishes short videos** to YouTube and Instagram,
fully automated up to a one-click approval, with a dashboard to follow every step and open every artifact.

---

## 1. Decisions

| Topic | Decision |
|---|---|
| Core unit | **Project**. Each project sets its niche, audience, language, format, duration, aspect ratio, style(s), voice/music, linked channels and posting rhythm. Many projects run side by side. |
| AI | Claude only, on the **Claude Pro subscription — no API key**. The worker runs the Claude Code CLI headless (`claude -p`) for research, scripting, production and review. |
| Video engine | `lemo-opuscar` skill (code-rendered films, voice, music) run inside the headless Claude session. |
| Approval | Automatic up to a finished, checked video → you click **Approve** → it is scheduled. Per-project switch for full auto later. |
| Hosting | This Mac. Dashboard only on `localhost` (no login needed). Built so it can move to a server later. |
| Platforms | YouTube (incl. Shorts) and Instagram (Reels). Publishing is behind a common adapter so TikTok/X can be added later. |
| Audio default | AI voiceover + background music + burned-in captions. Each can be turned off per project. |
| Language default | English; set per project. |
| Instagram video link | Instagram fetches the video from a public URL. Default: a temporary Cloudflare quick tunnel opened only while posting (free, no account). Optional: Cloudflare R2 bucket. |
| Spend control | No money cost beyond Pro. Limits are about **Claude usage**: one Claude job at a time, daily video cap per project, auto pause/resume on usage limits. |
| Alerts | macOS notification when a video is ready for approval, published, or failed. |
| Accounts | Connectors (YouTube, Instagram) are built and testable without real accounts; you create and connect the accounts later. Until then, approved videos stay in a "ready to publish" state. |
| First project | None preset; you create projects in the dashboard. A built-in demo project is used only for testing. |

All defaults above were confirmed on 2026-11-10.

---

## 2. How a video is made

```
Project schedule ─▶ Research ─▶ Script ─▶ Produce ─▶ Check ─▶ [Approve] ─▶ Schedule ─▶ Published ─▶ Stats
```

| # | Stage | How | Output files | Done when |
|---|---|---|---|---|
| 1 | **Research** | `claude -p` with web search. Finds 5 trending topic ideas in the project niche, scores them, skips anything too close to past videos. Picks the best. | `research.md`, `topics.json` | A topic with sources is chosen |
| 2 | **Script** | `claude -p`. Hook, voiceover script timed to the duration, style pick, title, description, hashtags, thumbnail text. | `script.md`, `metadata.json` | Script fits the duration and the metadata is valid |
| 3 | **Produce** | `claude -p` with the `lemo-opuscar` skill. The prompt carries the script and project settings so the skill's question round is answered up front. Treatment → render → voice → music → captions. | `TREATMENT.md`, stills, `final.mp4`, `captions.srt`, `thumbnail.png` | `final.mp4` exists |
| 4 | **Check** | First free checks with ffprobe: length, aspect ratio, resolution, audio present, loudness. Only if they pass: `claude -p` looks at sampled frames and the script for errors. | `check.json`, frame grid image | All checks pass (else back to 3, max 2 retries) |
| 5 | **Approve** | You, in the dashboard: watch, edit title/description, pick time, Approve or Reject (with a note that feeds a redo). | — | Approved |
| 6 | **Schedule & publish** | YouTube: upload as private with `publishAt`. Instagram: our scheduler posts the Reel at the chosen time. | post IDs, links | Live on each platform |
| 7 | **Stats** | Daily pull of views, likes, comments. | stats rows | — |

Each Claude stage is one `claude -p` run inside the video's folder, with:
- a prompt built from the project settings and earlier stage files,
- only the tools that stage needs (`--allowedTools`),
- `--output-format stream-json`, saved as the stage's live log in the dashboard.

**Failure rules**
- Any stage can be retried from the dashboard; retrying a stage re-runs everything after it.
- Errors are retried automatically twice, then the video is marked **Failed** with the reason.
- If Claude reports its usage limit, the job becomes **Waiting for usage** and resumes when the limit resets. Nothing is lost.

---

## 3. System design

```
┌──────────── Dashboard (React, localhost:4317) ──────────────┐
│ Projects · Pipeline · Video detail · Calendar · Channels    │
└───────────────▲──────────────────────────┬──────────────────┘
        live updates (SSE)            actions (HTTP)
┌───────────────┴──────────────────────────▼──────────────────┐
│ Worker (Node)                                               │
│  queue · stage runners · scheduler (cron) · publishers      │
│      │                │                      │              │
│  claude -p        ffmpeg/ffprobe     YouTube / Instagram    │
│  (Pro login)      lemo-opuscar         APIs                 │
└──────┬──────────────────────────────────────────────────────┘
   SQLite DB + files in data/
```

**Stack (as built):** TypeScript everywhere. One Node process (Hono) serves the API, runs the pipeline/scheduler loops and serves the dashboard (React + Vite + Tailwind). SQLite via Node's built-in `node:sqlite`. Server-Sent Events for live progress. One port: 4317.

**Always on:** a `launchd` agent starts the dashboard and worker at login. The worker keeps the Mac awake (`caffeinate`) only while a job runs. Missed schedules run as soon as the Mac wakes.

### Folder layout
```
video-production/
  server/src/        API, pipeline + stages, Claude runner, publishers, scheduler, health checks
  server/test/       connector + scheduling tests (fake YouTube/Instagram servers)
  web/src/           dashboard pages
  prompts/           editable prompt templates per stage
  skills/lemo-opuscar/  the video skill (copied from Claude Desktop)
  scripts/autostart.sh  start at login (launchd)
  data/              app.db, secret.key, projects/p<id>/v<id>/ (research.md, script.md, film/, final.mp4, logs/ …)
```

### Data model
| Table | Key fields |
|---|---|
| `projects` | name, niche, audience, language, format, duration_sec, aspect_ratio, styles[], voice, music, captions, cadence (e.g. "1/day at 18:00"), daily_cap, auto_publish, active |
| `channels` | platform, account name, encrypted tokens, expiry, status |
| `project_channels` | project ↔ channel |
| `videos` | project, topic, title, status, current stage, scheduled_at, created_at |
| `stage_runs` | video, stage, attempt, status, started/finished, error, log path |
| `artifacts` | video, stage, kind (markdown/image/video/json/audio), path |
| `posts` | video, channel, platform post id, url, scheduled_at, published_at, status |
| `stats` | post, date, views, likes, comments |
| `settings` | global caps, quiet hours, notifications |

Video status: `queued → researching → scripting → producing → checking → awaiting_approval → scheduled → published` (+ `waiting_for_usage`, `failed`, `rejected`).

---

## 4. Dashboard

Clean, light/dark, one accent color, plenty of space. Desktop-first, works on mobile.

| Page | What you see / do |
|---|---|
| **Home** | Today at a glance: videos in progress, waiting for approval, scheduled next, failures, Claude usage state. |
| **Projects** | Cards per project. Create/edit with a short form: niche, audience, language, format, duration, aspect ratio, style picker (with previews), voice/music/captions, channels, rhythm, daily cap. Pause/resume. "Make a video now" button. |
| **Pipeline** | Board with one column per stage; cards move live. Filter by project. |
| **Video detail** | Stage timeline with time spent and status; live log for the running stage; artifact viewer (rendered markdown, image gallery, video player); edit title/description/hashtags; Approve / Reject with note / Retry from a stage. |
| **Approvals** | Queue of finished videos to watch and approve quickly. |
| **Calendar** | Week/month view of scheduled and published posts; drag to reschedule. |
| **Channels** | Connect / reconnect YouTube and Instagram; token health. |
| **Settings** | Global caps, quiet hours, notifications, tool health check (Claude CLI login, ffmpeg, skill). |

---

## 5. Publishing details

**YouTube**
- OAuth with your Google Cloud app; scope `youtube.upload` + `youtube.readonly`.
- Upload private with `status.publishAt`. The AI-content disclosure is set on each upload.
- Shorts happen automatically for vertical videos under 3 minutes.
- Limits: about 6 uploads/day on the default quota.
- Until Google audits the app, API uploads are locked private, so the audit request is part of setup.

**Instagram**
- Instagram Business or Creator account linked to a Facebook Page, plus a Meta developer app.
- Instagram Graph API "Reels" flow: create container with a public `video_url` → wait for processing → publish.
- The API can't schedule, so our scheduler posts at the chosen time.
- Limit: 50 posts / 24h.

---

## 6. Milestones (each ends with something you can see)

| # | Milestone | You can… |
|---|---|---|
| M0 | Setup + health check | See green checks for Claude CLI login, ffmpeg, skill, Node. |
| M1 | Projects + Research + Script | Create a project, press "Make a video now", read the research and script. |
| M2 | Production + Check | Get a finished `final.mp4` from the skill, see the checks. Usage per film is measured here to set default caps. |
| M3 | Full dashboard | Watch everything live on the board, open artifacts, approve/reject/retry. |
| M4 | YouTube connector | OAuth + upload + scheduling built and tested against mocks; works end to end once you add the Google app keys. |
| M5 | Instagram connector | Reels flow + tunnel + scheduler built and tested against mocks; works end to end once you add the Meta app keys. |
| M6 | Autopilot + Stats | Projects run on their rhythm unattended; calendar and stats filled in; macOS alerts; starts at login. |

**Status (2026-11-10):** M0–M6 built. Verified on this Mac: full pipeline in test mode, dashboard pages, connector flows against fake YouTube/Instagram servers (`npm test`).
Not yet verified: real Claude runs (CLI not logged in yet), a real lemo-opuscar render (needs ffmpeg 7+ and Python 3.11+/uv), real platform posting (needs your accounts), and the Cloudflare quick tunnel against the live internet.

---

## 7. What only you can do

These need your accounts or your password, so I'll prepare the steps and you click through them:

1. **Claude Code CLI**: `npm install -g @anthropic-ai/claude-code`, then run `claude` once and log in with your Pro account. *(Needed for M1.)*
2. **ffmpeg**: `brew install ffmpeg`. *(Needed for M2.)*
3. **Newer Python** if the voice tools need it: `brew install python@3.12`. *(M2, I'll tell you.)*
4. **Google Cloud**: create a project, turn on YouTube Data API v3, create an OAuth client (I'll write the exact steps), and request the API audit. *(Needed for M4.)*
5. **Instagram**: switch to a Business/Creator account, link it to a Facebook Page, create a Meta developer app (steps provided). *(Needed for M5.)*
6. **Connect channels** in the dashboard (sign-in pop-ups). *(M4/M5.)*

---

## 8. Risks and limits

- **Pro usage limits** cap output; a film is a long session. Expect a few videos a day; your own Claude chats share the same limits. Measured in M2.
- **Headless skill runs**: the skill was made to be interactive; prompts must answer its questions up front. Proven in M2 before building on it.
- **YouTube audit** can take weeks; until then uploads stay private.
- **Mac must be on** (asleep is OK only if wake is scheduled) for posts to go out on time.
- **Platform rules**: AI-generated content must be disclosed; repetitive mass-produced content can be demonetized or limited — research de-duplication and style variety help.
- **Pro plan terms**: fine for personal automation on your own Mac; not for a service other people sign into.
