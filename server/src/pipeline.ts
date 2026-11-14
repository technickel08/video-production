import fs from 'node:fs';
import { all, get, run, now, getProject, getVideo, getSetting, updateVideo, type Project, type Stage, type Video } from './db.ts';
import { RUNNERS, makeCtx } from './stages.ts';
import { changed, notify } from './events.ts';
import { cancelCurrent } from './claude.ts';
import { videoDir } from './paths.ts';
import { recordUsage, backfillUsage } from './usage.ts';
import { syncVideoSoon } from './storage.ts';

const WORK_STAGES: Stage[] = ['research', 'script', 'production', 'produce', 'check'];
/** Steps you can review before the next one starts. The film itself is reviewed at the final approval. */
export const REVIEW_STAGES: Stage[] = ['research', 'script', 'production'];
const STAGE_NAME: Record<string, string> = { research: 'Research', script: 'Script', production: 'Production' };

/** The step after `stage` for this project (Production is skipped when the project has it off). */
function nextStage(project: Project, stage: Stage): Stage | undefined {
  const order = WORK_STAGES.filter((s) => s !== 'production' || project.production_step);
  const i = order.indexOf(stage);
  return i >= 0 ? order[i + 1] : 'produce';   // only Production can be missing from the order
}
const MAX_PRODUCE_ATTEMPTS = 3;
const MAX_ERROR_RETRIES = 2;

let busyVideo: number | null = null;
export const busy = () => busyVideo;

/**
 * Background Claude jobs (analyst, skill scout) share the one worker with video steps, so two Claude runs
 * never compete for the same usage allowance. Returns false when the worker is taken; the caller retries later.
 */
let sideJob: string | null = null;
export const sideBusy = () => sideJob;
export async function runSideJob(name: string, fn: () => Promise<void>): Promise<boolean> {
  if (busyVideo !== null || sideJob || usageGate() || getSetting('paused', false)) return false;
  sideJob = name;
  try { await fn(); } finally { sideJob = null; }
  return true;
}
export const setUsageWait = (retryAt: string) => setSettingSafe('usage_wait_until', retryAt);

export function createVideo(projectId: number): Video {
  const r = run(`INSERT INTO videos(project_id, stage, status, created_at, updated_at) VALUES (?, 'research', 'queued', ?, ?)`, projectId, now(), now());
  const v = getVideo(Number(r.lastInsertRowid))!;
  fs.mkdirSync(videoDir(projectId, v.id), { recursive: true });
  changed('video', v.id);
  return v;
}

/** Recover from a restart: anything that was running goes back in the queue. */
export function recover() {
  run(`UPDATE stage_runs SET status='failed', error='interrupted by restart', finished_at=? WHERE status='running'`, now());
  run(`UPDATE videos SET status='queued' WHERE status='running'`);
  try { backfillUsage(); } catch (e: any) { console.error('usage backfill failed:', e.message); }
}

function nextJob(): Video | undefined {
  if (getSetting('paused', false)) return;
  return get<Video>(`SELECT v.* FROM videos v JOIN projects p ON p.id=v.project_id
    WHERE (v.status='queued' OR v.status='waiting_usage') AND (v.retry_at IS NULL OR v.retry_at<=?)
    ORDER BY CASE v.status WHEN 'waiting_usage' THEN 0 ELSE 1 END, v.created_at LIMIT 1`, now());
}

/** If the subscription limit was hit, every queued job waits until the earliest reset. */
function usageGate(): boolean {
  const until = getSetting<string | null>('usage_wait_until', null);
  return !!until && until > now();
}

export async function tick() {
  if (busyVideo !== null || sideJob || usageGate()) return;
  const v = nextJob();
  if (!v) return;
  const project = getProject(v.project_id)!;
  busyVideo = v.id;
  try { await runStage(v, project); } finally { busyVideo = null; }
}

async function runStage(v: Video, project: Project) {
  const stage = v.stage;
  if (stage === 'production' && !project.production_step) { updateVideo(v.id, { stage: 'produce', status: 'queued' }); changed('video', v.id); return; }
  const runner = RUNNERS[stage];
  if (!runner) { updateVideo(v.id, { status: 'failed', error: `unknown stage ${stage}` }); return; }

  const r = run(`INSERT INTO stage_runs(video_id, stage, status, started_at) VALUES (?,?,'running',?)`, v.id, stage, now());
  const runId = Number(r.lastInsertRowid);
  updateVideo(v.id, { status: 'running', error: null, retry_at: null });
  const ctx = makeCtx({ ...v, status: 'running' }, project, runId);
  run('UPDATE stage_runs SET log_path=? WHERE id=?', ctx.logPath, runId);
  changed('video', v.id);

  let res;
  try { res = await runner(ctx); } catch (e: any) { res = { ok: false, error: e?.message || String(e) }; }
  try { recordUsage(runId, ctx.logPath); } catch {}

  // The video may have been deleted or rejected while running.
  if (!getVideo(v.id)) return;
  const cur = getVideo(v.id)!;
  if (cur.status !== 'running') { run(`UPDATE stage_runs SET status='cancelled', finished_at=? WHERE id=?`, now(), runId); changed('video', v.id); return; }

  if (res.usageLimited) {
    run(`UPDATE stage_runs SET status='waiting_usage', finished_at=?, error=? WHERE id=?`, now(), res.error ?? 'usage limit', runId);
    updateVideo(v.id, { status: 'waiting_usage', retry_at: res.retryAt!, error: `Claude usage limit reached — resumes ${new Date(res.retryAt!).toLocaleString()}` });
    setSettingSafe('usage_wait_until', res.retryAt);
    changed('video', v.id); changed('usage');
    return;
  }

  if (!res.ok) {
    run(`UPDATE stage_runs SET status='failed', finished_at=?, error=? WHERE id=?`, now(), res.error ?? 'failed', runId);
    const fails = get<{ n: number }>(`SELECT COUNT(*) n FROM stage_runs WHERE video_id=? AND stage=? AND status='failed'`, v.id, stage)!.n;
    if (!res.notLoggedIn && fails <= MAX_ERROR_RETRIES) {
      updateVideo(v.id, { status: 'queued', error: `${res.error} — retrying (${fails}/${MAX_ERROR_RETRIES})`, retry_at: new Date(Date.now() + 60_000 * fails).toISOString() });
    } else {
      updateVideo(v.id, { status: 'failed', error: res.error ?? 'failed' });
      notify('Video failed', `${cur.title || `Video #${v.id}`}: ${res.error}`);
    }
    changed('video', v.id);
    return;
  }

  run(`UPDATE stage_runs SET status='done', finished_at=? WHERE id=?`, now(), runId);
  syncVideoSoon(v.id);

  if (stage === 'check' && res.redo) {
    const issues = res.redo.map((i) => `- ${i}`).join('\n');
    if (cur.produce_attempts >= MAX_PRODUCE_ATTEMPTS) {
      updateVideo(v.id, { status: 'failed', error: `Quality check failed after ${cur.produce_attempts} attempts:\n${issues}` });
      notify('Video failed checks', cur.title || `Video #${v.id}`);
    } else {
      updateVideo(v.id, { stage: 'produce', status: 'queued', note: issues, error: null });
    }
    changed('video', v.id);
    return;
  }

  const next = nextStage(project, stage);
  if (next && project.review_steps && REVIEW_STAGES.includes(stage)) {
    updateVideo(v.id, { status: 'awaiting_review' });
    notify(`${STAGE_NAME[stage]} ready for review`, getVideo(v.id)!.title || `Video #${v.id}`);
  } else if (next) {
    updateVideo(v.id, { stage: next, status: 'queued' });
  } else {
    updateVideo(v.id, { stage: 'approval', status: 'awaiting_approval', note: null });
    if (project.auto_publish) approve(v.id);
    else notify('Ready for approval', cur.title || `Video #${v.id}`);
  }
  changed('video', v.id);
}

function setSettingSafe(key: string, value: unknown) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}

// ─── Actions from the dashboard ──────────────────────────────────────────────
export function approve(videoId: number, scheduledAt?: string, visibility?: string) {
  const v = getVideo(videoId);
  if (!v) throw new Error('video not found');
  if (!['awaiting_approval', 'ready_to_publish', 'scheduled'].includes(v.status) && !(v.stage === 'publish' && v.status === 'failed')) {
    throw new Error(`video is ${v.status}; only finished videos can be approved`);
  }
  const project = getProject(v.project_id)!;
  if (visibility && !['public', 'unlisted', 'private'].includes(visibility)) throw new Error('visibility must be public, unlisted or private');
  const vis = visibility ?? (v.status === 'awaiting_approval' ? project.visibility : v.visibility) ?? 'public';
  const when = scheduledAt ? new Date(scheduledAt).toISOString() : (v.scheduled_at && v.scheduled_at > now() ? v.scheduled_at : nextSlot(project, videoId));
  const channels = all<{ id: number; platform: string }>(`SELECT c.id, c.platform FROM channels c JOIN project_channels pc ON pc.channel_id=c.id
    WHERE pc.project_id=? AND c.status='connected'`, project.id)
    // Instagram's API can only post public Reels.
    .filter((c) => vis === 'public' || c.platform !== 'instagram');
  run(`DELETE FROM posts WHERE video_id=? AND platform='instagram' AND status IN ('pending','failed') AND ?<>'public'`, videoId, vis);

  for (const c of channels) {
    const existing = get<{ id: number; status: string }>('SELECT id, status FROM posts WHERE video_id=? AND channel_id=?', videoId, c.id);
    if (!existing) run(`INSERT INTO posts(video_id, channel_id, platform, status, scheduled_at) VALUES (?,?,?,'pending',?)`, videoId, c.id, c.platform, when);
    else if (existing.status === 'pending' || existing.status === 'failed') run(`UPDATE posts SET status='pending', scheduled_at=?, error=NULL WHERE id=?`, when, existing.id);
  }
  updateVideo(videoId, { stage: 'publish', status: channels.length ? 'scheduled' : 'ready_to_publish', scheduled_at: when, error: null, visibility: vis as any });
  changed('video', videoId);
}

/** Accept a reviewed step (research, script or production) and start the next one. */
export function approveStep(videoId: number) {
  const v = getVideo(videoId);
  if (!v) throw new Error('video not found');
  if (v.status !== 'awaiting_review') throw new Error('this video is not waiting for a step review');
  const next = nextStage(getProject(v.project_id)!, v.stage) ?? 'produce';
  // Feedback applied to this step is done with; later steps start clean.
  updateVideo(videoId, { stage: next, status: 'queued', note: null, error: null });
  changed('video', videoId);
}
/** When step reviews are switched off, videos waiting for one carry on. */
export function releaseReviews(projectId: number) {
  for (const v of all<{ id: number }>(`SELECT id FROM videos WHERE project_id=? AND status='awaiting_review'`, projectId)) approveStep(v.id);
}

/** Put a video aside without deleting anything. Posts that were not uploaded yet are dropped. */
export function archive(videoId: number) {
  const v = getVideo(videoId);
  if (!v) throw new Error('video not found');
  if (v.status === 'archived') return;
  if (v.status === 'published') throw new Error('This video is already published');
  const uploaded = get<{ n: number }>(`SELECT COUNT(*) n FROM posts WHERE video_id=? AND status IN ('scheduled','uploading','published')`, videoId)!.n;
  if (uploaded) throw new Error('This video is already uploaded to a platform, so it cannot be archived. Remove or unschedule it on the platform instead.');
  if (busyVideo === videoId) cancelCurrent();
  run(`DELETE FROM posts WHERE video_id=?`, videoId);
  updateVideo(videoId, { status: 'archived', archived_from: v.status, scheduled_at: null, error: null, retry_at: null });
  changed('video', videoId);
}
/** Bring an archived video back to where it was: finished videos return to approval, unfinished ones to their step. */
export function unarchive(videoId: number) {
  const v = getVideo(videoId);
  if (!v) throw new Error('video not found');
  if (v.status !== 'archived') throw new Error('this video is not archived');
  const was = v.archived_from ?? '';
  const finished = ['approval', 'publish', 'done'].includes(v.stage);
  const fields: Partial<Video> = finished ? { stage: 'approval', status: 'awaiting_approval' }
    : was === 'awaiting_review' || was === 'failed' || was === 'rejected' ? { status: was as Video['status'] }
    : { status: 'queued' };
  updateVideo(videoId, { ...fields, archived_from: null });
  changed('video', videoId);
}

export function reject(videoId: number, note: string, redoFrom: Stage = 'produce') {
  const v = getVideo(videoId);
  if (!v) throw new Error('video not found');
  if (busyVideo === videoId) cancelCurrent();
  if (note.trim() && WORK_STAGES.includes(redoFrom)) {
    updateVideo(videoId, { stage: redoFrom, status: 'queued', note: `- ${note.trim()}`, error: null, produce_attempts: 0 });
  } else {
    updateVideo(videoId, { status: 'rejected', error: note.trim() || null });
  }
  changed('video', videoId);
}

export function retry(videoId: number, stage?: Stage, feedback = '') {
  const v = getVideo(videoId);
  if (!v) throw new Error('video not found');
  if (busyVideo === videoId) cancelCurrent();
  const s = stage ?? v.stage;
  if (s === 'publish' || s === 'approval') {
    run(`UPDATE posts SET status='pending', error=NULL WHERE video_id=? AND status='failed'`, videoId);
    updateVideo(videoId, { stage: 'publish', status: 'scheduled', error: null });
  } else {
    if (s === 'produce' || s === 'check') run('UPDATE videos SET produce_attempts=0 WHERE id=?', videoId);
    // Your feedback replaces any earlier fix list; without feedback the earlier list (if any) is kept.
    const fields: Partial<Video> = { stage: s, status: 'queued', error: null, retry_at: null };
    if (feedback.trim()) fields.note = feedback.trim().split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.startsWith('-') ? l : `- ${l}`).join('\n');
    updateVideo(videoId, fields);
  }
  setSettingSafe('usage_wait_until', null);
  changed('video', videoId);
}

export function cancelVideo(videoId: number) {
  if (busyVideo === videoId) cancelCurrent();
}

// ─── Scheduling helpers ──────────────────────────────────────────────────────
/** Next free posting slot for a project, at least 20 minutes from now. */
export function nextSlot(p: Project, excludeVideo?: number, from = new Date()): string {
  const taken = new Set(all<{ scheduled_at: string }>(`SELECT scheduled_at FROM videos WHERE project_id=? AND scheduled_at IS NOT NULL AND id<>? AND status IN ('scheduled','ready_to_publish','published')`,
    p.id, excludeVideo ?? -1).map((r) => new Date(r.scheduled_at).getTime()));
  const times = (p.post_times.length ? p.post_times : ['18:00']).slice().sort();
  const days = p.post_days.length ? p.post_days : [0, 1, 2, 3, 4, 5, 6];
  const earliest = from.getTime() + 20 * 60_000;
  for (let d = 0; d < 60; d++) {
    const day = new Date(from); day.setDate(day.getDate() + d);
    if (!days.includes(day.getDay())) continue;
    for (const t of times) {
      const [h, m] = t.split(':').map(Number);
      const slot = new Date(day); slot.setHours(h, m || 0, 0, 0);
      if (slot.getTime() >= earliest && !taken.has(slot.getTime())) return slot.toISOString();
    }
  }
  return new Date(earliest).toISOString();
}

/** Autopilot: keep each project's pipeline fed, up to its daily cap. */
export function autopilot() {
  if (getSetting('paused', false)) return;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  for (const r of all('SELECT id FROM projects WHERE active=1 AND autopilot=1')) {
    const p = getProject(r.id)!;
    const today = get<{ n: number }>('SELECT COUNT(*) n FROM videos WHERE project_id=? AND created_at>=?', p.id, start.toISOString())!.n;
    const inFlight = get<{ n: number }>(`SELECT COUNT(*) n FROM videos WHERE project_id=? AND status IN ('queued','running','waiting_usage')`, p.id)!.n;
    if (today < p.daily_cap && inFlight === 0) createVideo(p.id);
  }
}
