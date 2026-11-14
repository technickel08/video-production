import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, now, getProject, getVideo, toProject, getSetting, setSetting, STAGES, type Stage } from './db.ts';
import { bus, changed } from './events.ts';
import { createVideo, approve, approveStep, releaseReviews, archive, unarchive, reject, retry, cancelVideo, nextSlot, busy } from './pipeline.ts';
import { PUBLISHERS, statsTick, publishTick, publishNow, repairOrphans } from './publish.ts';
import { health, testClaude, installVideoTools, installState } from './health.ts';
import { listStyles } from './styles.ts';
import { VOICES, VOICE_IDS, voicePreview } from './voices.ts';
import { performance } from './insights.ts';
import { s3Configured, testS3, syncAll, restoreAll, backupDatabase, deleteVideoFiles, syncVideoSoon } from './storage.ts';
import { videoDir, PROJECTS_DIR, localPath } from './paths.ts';
import { describeEvent } from './claude.ts';
import { auth, currentUser } from './auth.ts';
import { listNotes, unreadCount, markRead } from './inbox.ts';
import { buildDataset, readPlaybook, listProposals, applyProposal, dismissProposal, undoProposal, setLessonStatus, approvalStats, requestAnalysis, analysisRequested, learningDir, learningTick } from './learning.ts';
import { listSkills, installSkill, removeSkill, dismissSkill, trySkill, skillStyles, latestScoutReport, requestScout, scoutTick, installedSkills } from './skills.ts';
import { recentJobs } from './jobs.ts';
import { sideBusy } from './pipeline.ts';

export const api = new Hono();

api.onError((e, c) => c.json({ error: e.message }, 400));
api.route('/auth', auth);

// ─── Live events ─────────────────────────────────────────────────────────────
api.get('/events', (c) => streamSSE(c, async (s) => {
  const send = (e: unknown) => { s.writeSSE({ data: JSON.stringify(e) }).catch(() => {}); };
  bus.on('event', send);
  const ping = setInterval(() => send({ kind: 'ping' }), 25_000);
  await new Promise<void>((resolve) => s.onAbort(() => resolve()));
  clearInterval(ping); bus.off('event', send);
}));

// ─── Overview ────────────────────────────────────────────────────────────────
api.get('/overview', (c) => {
  const count = (where: string) => get<{ n: number }>(`SELECT COUNT(*) n FROM videos WHERE ${where}`)!.n;
  return c.json({
    inProgress: count(`status IN ('queued','running','waiting_usage')`),
    awaiting: count(`status IN ('awaiting_approval','awaiting_review')`),
    unread: unreadCount(),
    proposals: get<{ n: number }>(`SELECT COUNT(*) n FROM proposals WHERE status='pending'`)!.n,
    scheduled: count(`status IN ('scheduled','ready_to_publish')`),
    published: count(`status='published'`),
    failed: count(`status='failed'`),
    running: busy(),
    paused: getSetting('paused', false),
    usageWaitUntil: (() => { const u = getSetting<string | null>('usage_wait_until', null); return u && u > now() ? u : null; })(),
    mock: getSetting('mock_mode', false),
    next: all(`SELECT p.*, v.title, v.project_id, c.name channel_name FROM posts p JOIN videos v ON v.id=p.video_id JOIN channels c ON c.id=p.channel_id
      WHERE p.status IN ('pending','scheduled') ORDER BY p.scheduled_at LIMIT 5`),
    recent: all(`SELECT v.*, pr.name project_name, pr.aspect_ratio FROM videos v JOIN projects pr ON pr.id=v.project_id ORDER BY v.updated_at DESC LIMIT 8`)
      .map((v: any) => ({ ...v, has_poster: fs.existsSync(path.join(videoDir(v.project_id, v.id), 'poster.jpg')) })),
    totals: get(`SELECT COALESCE(SUM(views),0) views, COALESCE(SUM(likes),0) likes, COALESCE(SUM(comments),0) comments FROM stats s
      WHERE date=(SELECT MAX(date) FROM stats s2 WHERE s2.post_id=s.post_id)`),
  });
});

// ─── Projects ────────────────────────────────────────────────────────────────
const PROJECT_FIELDS = ['name', 'niche', 'audience', 'language', 'format', 'duration_sec', 'aspect_ratio', 'styles', 'voice', 'music', 'captions',
  'notes', 'post_times', 'post_days', 'daily_cap', 'autopilot', 'auto_publish', 'active', 'visibility',
  'voice_name', 'voice_speed', 'voice_style', 'music_mood', 'production_step', 'review_steps', 'adapt_mode', 'focus', 'extra_skills'] as const;

function projectValues(body: any) {
  const out: Record<string, any> = {};
  for (const k of PROJECT_FIELDS) {
    if (!(k in body)) continue;
    const v = body[k];
    out[k] = Array.isArray(v) ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  if (out.name !== undefined && !String(out.name).trim()) throw new Error('Project name is required');
  if (out.adapt_mode !== undefined && !['ask', 'auto'].includes(out.adapt_mode)) throw new Error('Adaptation must be ask or auto');
  if (out.visibility !== undefined && !['public', 'unlisted', 'private'].includes(out.visibility)) throw new Error('Visibility must be public, unlisted or private');
  if (out.voice_speed !== undefined && !(Number(out.voice_speed) === 0 || (Number(out.voice_speed) >= 0.7 && Number(out.voice_speed) <= 1.3))) throw new Error('Voice speed must be between 0.7 and 1.3');
  if (out.voice_name !== undefined && out.voice_name && !VOICE_IDS.has(out.voice_name)) throw new Error(`Unknown voice "${out.voice_name}"`);
  if (out.duration_sec !== undefined && !(Number(out.duration_sec) >= 5 && Number(out.duration_sec) <= 1800)) throw new Error('Duration must be 5–1800 seconds');
  if (out.post_times) for (const t of JSON.parse(out.post_times)) if (!/^\d{1,2}:\d{2}$/.test(t)) throw new Error(`Bad posting time "${t}" (use HH:MM)`);
  return out;
}
function setChannels(projectId: number, ids?: number[]) {
  if (!Array.isArray(ids)) return;
  run('DELETE FROM project_channels WHERE project_id=?', projectId);
  for (const id of ids) run('INSERT OR IGNORE INTO project_channels(project_id, channel_id) VALUES (?,?)', projectId, id);
  if (ids.length) releaseWaiting(projectId);
}
/** Approved videos that were waiting for a channel get scheduled as soon as one is linked. */
function releaseWaiting(projectId: number) {
  for (const v of all<{ id: number }>(`SELECT v.id FROM videos v WHERE v.project_id=? AND (v.status='ready_to_publish'
      OR (v.stage='publish' AND v.status='scheduled' AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.video_id=v.id))) ORDER BY v.scheduled_at`, projectId)) {
    try { approve(v.id); } catch (e: any) { console.error(`[release ${v.id}]`, e.message); }
  }
}
function projectWithCounts(p: any) {
  const counts = all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM videos WHERE project_id=? GROUP BY status', p.id);
  return { ...p, counts: Object.fromEntries(counts.map((x) => [x.status, x.n])), next_slot: nextSlot(p), adapt_stats: approvalStats(p.id),
    pending_proposals: get<{ n: number }>(`SELECT COUNT(*) n FROM proposals WHERE project_id=? AND status='pending'`, p.id)!.n };
}

api.get('/projects', (c) => c.json(all('SELECT * FROM projects ORDER BY created_at DESC').map(toProject).map(projectWithCounts)));
api.get('/projects/:id', (c) => { const p = getProject(Number(c.req.param('id'))); return p ? c.json(projectWithCounts(p)) : c.json({ error: 'not found' }, 404); });
api.post('/projects', async (c) => {
  const body = await c.req.json();
  const v = projectValues({ name: 'Untitled', ...body });
  const keys = Object.keys(v);
  const r = run(`INSERT INTO projects(${keys.join(',')}, created_at) VALUES (${keys.map(() => '?').join(',')}, ?)`, ...keys.map((k) => v[k]), now());
  const id = Number(r.lastInsertRowid);
  setChannels(id, body.channel_ids);
  if (body.review_steps === false) releaseReviews(id);
  changed('project', id);
  return c.json(getProject(id));
});
api.put('/projects/:id', async (c) => {
  const id = Number(c.req.param('id')); const body = await c.req.json();
  const v = projectValues(body); const keys = Object.keys(v);
  if (keys.length) run(`UPDATE projects SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => v[k]), id);
  setChannels(id, body.channel_ids);
  changed('project', id);
  return c.json(getProject(id));
});
api.delete('/projects/:id', (c) => {
  const id = Number(c.req.param('id'));
  for (const v of all<{ id: number }>('SELECT id FROM videos WHERE project_id=?', id)) cancelVideo(v.id);
  run('DELETE FROM projects WHERE id=?', id);
  fs.rmSync(path.join(PROJECTS_DIR, `p${id}`), { recursive: true, force: true });
  changed('project', id);
  return c.json({ ok: true });
});
api.post('/projects/:id/run', (c) => c.json(createVideo(Number(c.req.param('id')))));

// ─── Videos ──────────────────────────────────────────────────────────────────
api.get('/videos', (c) => {
  const pid = c.req.query('project');
  const rows = all(`SELECT v.*, p.name project_name, p.aspect_ratio, p.production_step FROM videos v JOIN projects p ON p.id=v.project_id
    ${pid ? 'WHERE v.project_id=?' : ''} ORDER BY v.created_at DESC LIMIT 300`, ...(pid ? [Number(pid)] : []));
  return c.json(rows.map((v: any) => ({ ...v, has_poster: fs.existsSync(path.join(videoDir(v.project_id, v.id), 'poster.jpg')) })));
});

function artifactStage(rel: string): Stage {
  if (/^(research\.md|topics\.json)$/.test(rel)) return 'research';
  if (/^(script\.md|metadata\.json|hook\.json)$/.test(rel)) return 'script';
  if (/^production\.(md|json)$/.test(rel)) return 'production';
  if (/^(check\.json|review\.json|grid\.jpg|hook\.jpg)$/.test(rel)) return 'check';
  return 'produce';
}
function listArtifacts(dir: string) {
  const out: { path: string; stage: Stage; kind: string; size: number; mtime: string }[] = [];
  const kindOf = (f: string) => /\.(mp4|mov|webm)$/i.test(f) ? 'video' : /\.(png|jpe?g|webp|gif)$/i.test(f) ? 'image' : /\.(wav|mp3|m4a|ogg)$/i.test(f) ? 'audio'
    : /\.md$/i.test(f) ? 'markdown' : /\.json$/i.test(f) ? 'json' : /\.(srt|vtt|txt)$|CREDITS$/i.test(f) ? 'text' : null;
  const walk = (d: string, depth: number) => {
    if (!fs.existsSync(d) || depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['node_modules', 'logs', 'frames', 'cache', '.cache'].includes(e.name)) continue;
      const f = path.join(d, e.name); const rel = path.relative(dir, f);
      if (e.isDirectory()) { walk(f, depth + 1); continue; }
      const kind = kindOf(e.name); if (!kind) continue;
      if (rel.startsWith('film/') && kind === 'json') continue;
      const st = fs.statSync(f);
      out.push({ path: rel, stage: artifactStage(rel), kind, size: st.size, mtime: st.mtime.toISOString() });
      if (out.length > 300) return;
    }
  };
  walk(dir, 0);
  const order = ['final.mp4', 'poster.jpg', 'research.md', 'script.md', 'metadata.json', 'check.json', 'review.json', 'grid.jpg'];
  return out.sort((a, b) => ((order.indexOf(a.path) + 1 || 99) - (order.indexOf(b.path) + 1 || 99)) || a.path.localeCompare(b.path));
}

api.get('/videos/:id', (c) => {
  const v = getVideo(Number(c.req.param('id')));
  if (!v) return c.json({ error: 'not found' }, 404);
  const dir = videoDir(v.project_id, v.id);
  let meta = null; try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')); } catch {}
  let hook = null; try { hook = JSON.parse(fs.readFileSync(path.join(dir, 'hook.json'), 'utf8')); } catch {}
  return c.json({
    ...v, project: getProject(v.project_id), meta, hook,
    runs: all('SELECT * FROM stage_runs WHERE video_id=? ORDER BY id', v.id),
    artifacts: listArtifacts(dir),
    posts: all(`SELECT p.*, c.name channel_name FROM posts p JOIN channels c ON c.id=p.channel_id WHERE video_id=?`, v.id),
    stats: all(`SELECT s.*, p.platform FROM stats s JOIN posts p ON p.id=s.post_id WHERE p.video_id=? ORDER BY date`, v.id),
    running: busy() === v.id,
  });
});
api.get('/videos/:id/log/:runId', (c) => {
  const r = get<{ log_path: string; video_id: number }>('SELECT log_path, video_id FROM stage_runs WHERE id=?', Number(c.req.param('runId')));
  if (r?.log_path) r.log_path = localPath(r.log_path);
  if (!r?.log_path || r.video_id !== Number(c.req.param('id')) || !fs.existsSync(r.log_path)) return c.json({ lines: [] });
  const lines: string[] = [];
  for (const l of fs.readFileSync(r.log_path, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const e = JSON.parse(l); const t = e.type === 'note' ? e.text : describeEvent(e); if (t) lines.push(t); } catch {}
  }
  return c.json({ lines: lines.slice(-800) });
});
api.put('/videos/:id/metadata', async (c) => {
  const v = getVideo(Number(c.req.param('id'))); if (!v) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json();
  const file = path.join(videoDir(v.project_id, v.id), 'metadata.json');
  let meta: any = {}; try { meta = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  for (const k of ['title', 'description', 'hashtags']) if (k in body) meta[k] = body[k];
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  if (body.title) run('UPDATE videos SET title=?, updated_at=? WHERE id=?', body.title, now(), v.id);
  syncVideoSoon(v.id);
  changed('video', v.id);
  return c.json(meta);
});
api.post('/videos/:id/approve', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const id = Number(c.req.param('id'));
  approve(id, b.now ? new Date().toISOString() : b.scheduledAt, b.visibility);
  if (b.now) void publishTick();
  return c.json({ ok: true });
});
api.post('/videos/:id/archive', (c) => { archive(Number(c.req.param('id'))); return c.json({ ok: true }); });
api.post('/videos/:id/unarchive', (c) => { unarchive(Number(c.req.param('id'))); return c.json({ ok: true }); });
api.post('/videos/:id/continue', (c) => { approveStep(Number(c.req.param('id'))); return c.json({ ok: true }); });
api.post('/videos/:id/publish-now', async (c) => { await publishNow(Number(c.req.param('id'))); return c.json({ ok: true }); });
api.post('/videos/:id/reject', async (c) => { const b = await c.req.json().catch(() => ({})); reject(Number(c.req.param('id')), b.note ?? '', b.redoFrom); return c.json({ ok: true }); });
api.post('/videos/:id/retry', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (b.stage && !STAGES.includes(b.stage)) throw new Error('bad stage');
  retry(Number(c.req.param('id')), b.stage, typeof b.feedback === 'string' ? b.feedback : ''); return c.json({ ok: true });
});
api.delete('/videos/:id', (c) => {
  const v = getVideo(Number(c.req.param('id'))); if (!v) return c.json({ ok: true });
  cancelVideo(v.id);
  run('DELETE FROM videos WHERE id=?', v.id);
  fs.rmSync(videoDir(v.project_id, v.id), { recursive: true, force: true });
  deleteVideoFiles(v.project_id, v.id).catch((e) => console.error(`[s3] delete video ${v.id}: ${e.message}`));
  changed('video', v.id);
  return c.json({ ok: true });
});

// ─── Calendar & posts ────────────────────────────────────────────────────────
api.get('/calendar', (c) => {
  const from = c.req.query('from') || new Date(Date.now() - 31 * 86400_000).toISOString();
  const to = c.req.query('to') || new Date(Date.now() + 62 * 86400_000).toISOString();
  return c.json(all(`SELECT v.id video_id, v.title, v.status, v.scheduled_at, v.project_id, pr.name project_name,
      (SELECT json_group_array(json_object('id',p.id,'platform',p.platform,'status',p.status,'url',p.url,'channel',c.name))
         FROM posts p JOIN channels c ON c.id=p.channel_id WHERE p.video_id=v.id) posts
    FROM videos v JOIN projects pr ON pr.id=v.project_id
    WHERE v.scheduled_at BETWEEN ? AND ? AND v.status IN ('scheduled','ready_to_publish','published','failed') ORDER BY v.scheduled_at`, from, to)
    .map((r: any) => ({ ...r, posts: JSON.parse(r.posts) })));
});
api.post('/videos/:id/reschedule', async (c) => {
  const id = Number(c.req.param('id')); const { scheduledAt } = await c.req.json();
  const when = new Date(scheduledAt);
  if (isNaN(+when) || when.getTime() < Date.now()) throw new Error('Pick a time in the future');
  const posts = all<{ status: string; platform: string }>('SELECT status, platform FROM posts WHERE video_id=?', id);
  if (posts.some((p) => ['scheduled', 'uploading', 'published'].includes(p.status))) throw new Error('Already uploaded to a platform; change the time there');
  run('UPDATE posts SET scheduled_at=? WHERE video_id=? AND status IN (\'pending\',\'failed\')', when.toISOString(), id);
  run('UPDATE videos SET scheduled_at=?, updated_at=? WHERE id=?', when.toISOString(), now(), id);
  changed('video', id);
  return c.json({ ok: true });
});

// ─── Channels & OAuth ────────────────────────────────────────────────────────
api.get('/channels', (c) => c.json(all(`SELECT id, platform, name, external_id, status, created_at,
  (SELECT json_group_array(project_id) FROM project_channels WHERE channel_id=channels.id) projects FROM channels ORDER BY platform, name`)
  .map((r: any) => ({ ...r, projects: JSON.parse(r.projects) }))));
api.put('/channels/:id/projects', async (c) => {
  const id = Number(c.req.param('id'));
  const { project_ids } = await c.req.json();
  if (!Array.isArray(project_ids)) throw new Error('project_ids must be a list');
  run('DELETE FROM project_channels WHERE channel_id=?', id);
  for (const pid of project_ids) {
    run('INSERT OR IGNORE INTO project_channels(project_id, channel_id) VALUES (?,?)', Number(pid), id);
    releaseWaiting(Number(pid));
  }
  changed('channel');
  return c.json({ ok: true });
});
api.delete('/channels/:id', (c) => {
  run('DELETE FROM channels WHERE id=?', Number(c.req.param('id')));
  repairOrphans();
  changed('channel');
  return c.json({ ok: true });
});

const oauthStates = new Map<string, { platform: string; at: number }>();
api.get('/oauth/:platform/start', (c) => {
  const platform = c.req.param('platform'); const pub = PUBLISHERS[platform];
  if (!pub) return c.text('Unknown platform', 404);
  if (!pub.configured()) return c.redirect(`/settings?missing=${platform}`);
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { platform, at: Date.now() });
  return c.redirect(pub.authUrl(state));
});
api.get('/oauth/:platform/callback', async (c) => {
  const platform = c.req.param('platform'); const state = c.req.query('state') || '';
  const s = oauthStates.get(state); oauthStates.delete(state);
  const fail = (msg: string) => {
    console.error(`[oauth ${platform}] ${msg}`);
    return c.redirect(`/channels?error=${encodeURIComponent(msg)}`);
  };
  if (!s || s.platform !== platform) return fail('This sign-in link was already used or the app restarted during sign-in. Press Connect again (it starts a fresh sign-in).');
  if (Date.now() - s.at > 60 * 60_000) return fail('Sign-in took longer than an hour. Press Connect again.');
  if (c.req.query('error')) return fail(`Google/Meta returned: ${c.req.query('error_description') || c.req.query('error')}`);
  try {
    const ids = await PUBLISHERS[platform].handleCallback(c.req.query('code') || '');
    console.log(`[oauth ${platform}] connected ${ids.length} account(s)`);
    changed('channel');
    return c.redirect(`/channels?connected=${ids.length}`);
  } catch (e: any) {
    return fail(e.message);
  }
});

// ─── Settings & health ───────────────────────────────────────────────────────
const SETTING_KEYS = ['paused', 'mock_mode', 'notifications', 'claude_model', 'model_research', 'model_script', 'model_production', 'model_produce', 'model_check', 'model_analyst', 'model_scout', 'scout_enabled', 'scout_every_days', 'claude_path', 'produce_timeout_min', 'youtube_client_id', 'youtube_client_secret',
  'youtube_category', 'meta_app_id', 'meta_app_secret', 'public_base_url',
  's3_bucket', 's3_region', 's3_endpoint', 's3_prefix', 's3_access_key_id', 's3_secret_access_key'];
const SECRET_KEYS = ['youtube_client_secret', 'meta_app_secret', 's3_secret_access_key'];
api.get('/settings', (c) => c.json(Object.fromEntries(SETTING_KEYS.map((k) => {
  const v = getSetting<any>(k, null);
  return [k, SECRET_KEYS.includes(k) ? (v ? '••••••••' : '') : v];
}))));
api.put('/settings', async (c) => {
  const body = await c.req.json();
  // Members may pause and resume; everything else in Settings is the admin's.
  if (currentUser(c).role !== 'admin' && Object.keys(body).some((k) => k !== 'paused')) return c.json({ error: 'Only the admin can change settings' }, 403);
  for (const [k, v] of Object.entries(body)) {
    if (!SETTING_KEYS.includes(k)) continue;
    if (SECRET_KEYS.includes(k) && v === '••••••••') continue;
    setSetting(k, v);
    if (k === 'paused' && v === false) setSetting('usage_wait_until', null);
  }
  changed('settings');
  return c.json({ ok: true });
});
api.get('/health', async (c) => c.json({ checks: await health(), install: installState() }));
api.post('/health/claude-test', async (c) => c.json(await testClaude()));
api.post('/health/install-tools', (c) => c.json(installVideoTools()));
api.get('/styles', (c) => c.json([...listStyles(), ...skillStyles()]));

// ─── What's new ──────────────────────────────────────────────────────────────
api.get('/notifications', (c) => c.json(listNotes().map((n) => {
  // Attach the current state of whatever the note is about, so its buttons match (e.g. already approved).
  const [kind, id] = (n.ref ?? '').split(':');
  const state = kind === 'proposal' ? get<{ status: string }>('SELECT status FROM proposals WHERE id=?', Number(id))?.status
    : kind === 'skill' ? get<{ status: string }>('SELECT status FROM skills WHERE id=?', Number(id))?.status : undefined;
  return { ...n, state: state ?? null };
})));
api.post('/notifications/read', async (c) => { const b = await c.req.json().catch(() => ({})); markRead(Array.isArray(b.ids) ? b.ids.map(Number) : undefined); return c.json({ ok: true }); });

// ─── Learning ────────────────────────────────────────────────────────────────
api.get('/learning/:pid', (c) => {
  const pid = Number(c.req.param('pid')); const p = getProject(pid);
  if (!p) return c.json({ error: 'not found' }, 404);
  let md = ''; try { md = fs.readFileSync(path.join(learningDir(pid), 'playbook.md'), 'utf8'); } catch {}
  const data = buildDataset(pid);
  return c.json({
    project: { id: p.id, name: p.name, adapt_mode: p.adapt_mode, focus: p.focus, analyzed_at: p.analyzed_at },
    playbook: readPlaybook(pid), playbook_md: md, proposals: listProposals(pid), stats: approvalStats(pid),
    medians: data.medians, measured: data.measured, published: data.published,
    videos: data.videos.map((v) => ({ id: v.id, title: v.title, published_at: v.published_at, style: v.style, tags: v.tags, hook: v.hook, platforms: v.platforms })),
    jobs: recentJobs('analyst', pid, 5), queued: analysisRequested(pid), running: sideBusy() === `analyst:${pid}`,
    analytics_error: getSetting<string | null>('yt_analytics_error', null), analytics_missing: getSetting('yt_analytics_missing', false),
  });
});
api.post('/learning/:pid/analyse', (c) => { const pid = Number(c.req.param('pid')); requestAnalysis(pid); void learningTick(); return c.json({ ok: true }); });
api.put('/learning/:pid/lessons/:lid', async (c) => {
  const b = await c.req.json();
  if (!['active', 'pinned', 'struck'].includes(b.status)) throw new Error('status must be active, pinned or struck');
  setLessonStatus(Number(c.req.param('pid')), c.req.param('lid'), b.status); return c.json({ ok: true });
});
api.post('/proposals/:id/approve', (c) => { applyProposal(Number(c.req.param('id'))); return c.json({ ok: true }); });
api.post('/proposals/:id/dismiss', (c) => { dismissProposal(Number(c.req.param('id'))); return c.json({ ok: true }); });
api.post('/proposals/:id/undo', (c) => { undoProposal(Number(c.req.param('id'))); return c.json({ ok: true }); });

// ─── Skills ──────────────────────────────────────────────────────────────────
api.get('/skills', (c) => c.json({
  skills: listSkills().filter((s) => s.status !== 'skipped'), report: latestScoutReport(), jobs: recentJobs('scout', undefined, 5),
  running: sideBusy() === 'scout', last_run: getSetting('scout_last_run', null), enabled: getSetting('scout_enabled', true), every_days: getSetting('scout_every_days', 14),
}));
api.get('/skills/installed', (c) => c.json(installedSkills().map((s) => ({ id: s.id, slug: s.slug, name: s.name, kind: s.kind, summary: s.card.summary }))));
api.post('/skills/scout', (c) => { requestScout(); void scoutTick(); return c.json({ ok: true }); });
api.post('/skills/:id/install', async (c) => c.json(await installSkill(Number(c.req.param('id')))));
api.post('/skills/:id/dismiss', (c) => { dismissSkill(Number(c.req.param('id'))); return c.json({ ok: true }); });
api.post('/skills/:id/try', async (c) => { const b = await c.req.json(); trySkill(Number(c.req.param('id')), Number(b.projectId)); return c.json({ ok: true }); });
api.delete('/skills/:id', (c) => { removeSkill(Number(c.req.param('id'))); return c.json({ ok: true }); });
api.get('/projects/:id/insights', (c) => c.json(performance(Number(c.req.param('id')))));
api.post('/storage/test', async (c) => c.json({ ok: true, detail: await testS3() }));
api.post('/storage/sync', async (c) => { const r = await syncAll(); const backup = await backupDatabase(); return c.json({ ok: true, ...r, backup }); });
api.post('/storage/restore', async (c) => c.json({ ok: true, ...(await restoreAll()) }));
api.get('/voices', (c) => c.json(VOICES));
api.get('/voices/:id/preview', async (c) => {
  const file = await voicePreview(c.req.param('id'), Number(c.req.query('speed') || 0));
  return new Response(fs.readFileSync(file), { headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' } });
});
api.post('/stats/refresh', async (c) => { await statsTick(true); return c.json({ ok: true }); });

// ─── Artifact files (with range support for video seeking) ──────────────────
export function serveArtifact(videoId: number, rel: string, range?: string): { status: number; headers: Record<string, string>; stream: fs.ReadStream } | null {
  const v = getVideo(videoId); if (!v) return null;
  const dir = videoDir(v.project_id, v.id);
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const size = fs.statSync(file).size;
  const types: Record<string, string> = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
    '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.srt': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
  const type = types[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8';
  const m = range?.match(/bytes=(\d*)-(\d*)/);
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    return { status: 206, headers: { 'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' }, stream: fs.createReadStream(file, { start, end }) };
  }
  return { status: 200, headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes', 'cache-control': 'no-cache' }, stream: fs.createReadStream(file) };
}
