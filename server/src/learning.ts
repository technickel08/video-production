import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, now, getProject, getSetting, type Project } from './db.ts';
import { PROMPTS_DIR, PROJECTS_DIR, videoDir } from './paths.ts';
import { addNote } from './inbox.ts';
import { changed } from './events.ts';
import { runSideJob } from './pipeline.ts';
import { startJob, finishJob, jobClaude, modelFor } from './jobs.ts';
import { listStyles } from './styles.ts';
import { skillStyles } from './skills.ts';
import { VOICE_IDS } from './voices.ts';
import { performanceText } from './insights.ts';

/**
 * The learning loop for one project: measured results + what each video was → an analyst run →
 * a playbook (lessons the next videos read) and proposals (tweak / shift / pivot) that are applied
 * by the rules below. Every applied change records what it replaced so it can be undone.
 */
export const learningDir = (projectId: number) => path.join(PROJECTS_DIR, `p${projectId}`, 'learning');
const MIN_PUBLISHED = 3;            // no analysis before this many published videos
const MIN_GAP_HOURS = 20;           // at most about once a day

// ─── Data ────────────────────────────────────────────────────────────────────
const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const median = (xs: number[]) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

export function buildDataset(projectId: number) {
  const p = getProject(projectId)!;
  const vids = all<{ id: number; title: string; topic: string }>(`SELECT DISTINCT v.id, v.title, v.topic FROM videos v JOIN posts po ON po.video_id=v.id
    WHERE v.project_id=? AND po.status='published' ORDER BY v.id`, projectId);
  const videos = vids.map((v) => {
    const dir = videoDir(projectId, v.id);
    const meta = readJson(path.join(dir, 'metadata.json')) ?? {};
    const hook = readJson(path.join(dir, 'hook.json')); const review = readJson(path.join(dir, 'review.json')); const chk = readJson(path.join(dir, 'check.json'));
    const posts = all<{ id: number; platform: string; published_at: string }>(`SELECT id, platform, published_at FROM posts WHERE video_id=? AND status='published'`, v.id);
    const first = posts.map((x) => x.published_at).sort()[0];
    const platforms: Record<string, Record<string, any>> = {};
    for (const po of posts) {
      platforms[po.platform] = Object.fromEntries(all<{ checkpoint: string; data: string; taken_at: string }>('SELECT checkpoint, data, taken_at FROM metrics WHERE post_id=?', po.id)
        .map((m) => [m.checkpoint, { ...JSON.parse(m.data), taken_at: m.taken_at }]));
      if (chk?.duration) for (const cp of Object.values(platforms[po.platform])) if (cp.avg_view_sec != null && cp.avg_view_pct == null) cp.avg_view_pct = Math.round((cp.avg_view_sec / chk.duration) * 1000) / 10;
    }
    const d = first ? new Date(first) : null;
    return {
      id: v.id, title: meta.title || v.title, topic: v.topic, folder: dir, published_at: first,
      weekday: d?.toLocaleDateString('en-GB', { weekday: 'short' }), hour: d?.getHours(),
      duration_sec: chk?.duration ? Math.round(chk.duration) : null, style: meta.style ?? null, tags: meta.tags ?? null,
      hook: meta.hook || hook?.hook_line || null, hook_score: hook?.hook_score ?? null, title_score: hook?.title_score ?? null, review_score: review?.score ?? null,
      made_with: meta.made_with ?? null, platforms,
    };
  });
  const medians: Record<string, Record<string, { views: number | null; avg_view_pct: number | null }>> = {};
  for (const plat of ['youtube', 'instagram']) for (const cp of ['24h', '3d', '7d', 'latest']) {
    const rows = videos.map((v) => v.platforms[plat]?.[cp]).filter(Boolean);
    if (rows.length) (medians[plat] ??= {})[cp] = { views: median(rows.map((r) => r.views)), avg_view_pct: median(rows.map((r) => r.avg_view_pct)) };
  }
  const measured = videos.filter((v) => Object.values(v.platforms).some((x) => x['3d'] || x['24h'])).length;
  return { project: { id: p.id, name: p.name, niche: p.niche, focus: p.focus }, generated_at: now(), published: videos.length, measured, medians, videos };
}

// ─── Playbook ────────────────────────────────────────────────────────────────
export interface Lesson { id: string; text: string; evidence?: string; confidence?: 'low' | 'medium' | 'high'; status: 'active' | 'pinned' | 'struck' }
export interface Playbook { summary?: string; data_quality?: string; lessons: Lesson[]; unknowns?: string[]; next_tests?: string[]; updated_at?: string }
export const readPlaybook = (projectId: number): Playbook | null => readJson(path.join(learningDir(projectId), 'playbook.json'));
const writePlaybook = (projectId: number, pb: Playbook) => fs.writeFileSync(path.join(learningDir(projectId), 'playbook.json'), JSON.stringify(pb, null, 2));

/** Owner edits: pin a lesson (always kept), strike it (never used or re-added), or make it active again. */
export function setLessonStatus(projectId: number, lessonId: string, status: Lesson['status']) {
  const pb = readPlaybook(projectId); if (!pb) throw new Error('No playbook yet');
  const l = pb.lessons.find((x) => x.id === lessonId); if (!l) throw new Error('lesson not found');
  l.status = status; writePlaybook(projectId, pb); changed('learning', projectId);
}

/** What research, script and production read about past results. */
export function playbookText(projectId: number): string {
  const pb = readPlaybook(projectId);
  const lessons = (pb?.lessons ?? []).filter((l) => l.status !== 'struck');
  if (!lessons.length) return performanceText(projectId);
  return [
    `## What this channel has learned so far (playbook${pb?.updated_at ? `, updated ${pb.updated_at.slice(0, 10)}` : ''})`,
    ...lessons.map((l) => `- ${l.text}${l.status === 'pinned' ? ' (set by the owner — always follow)' : ` (${l.confidence ?? 'low'} confidence)`}`),
    ...(pb?.next_tests?.length ? ['Worth testing when it fits naturally: ' + pb.next_tests.slice(0, 3).join('; ')] : []),
    'Follow high-confidence lessons; treat low-confidence ones as hints, not rules.',
    '',
  ].join('\n');
}

// ─── Proposals ───────────────────────────────────────────────────────────────
type Level = 'tweak' | 'shift' | 'pivot';
const TWEAK = ['duration_sec', 'styles', 'post_times', 'voice_name', 'voice_speed', 'voice_style', 'music_mood'];
export const FIELDS: Record<Level, string[]> = { tweak: TWEAK, shift: ['focus', ...TWEAK], pivot: ['niche', 'audience', 'focus'] };
export interface Proposal { id: number; project_id: number; level: Level; title: string; reason: string; evidence: string; confidence: string; changes: Record<string, any>; before: Record<string, any> | null; status: 'pending' | 'applied' | 'dismissed' | 'undone' | 'rejected'; auto: boolean; created_at: string; decided_at: string | null }
const toProposal = (r: any): Proposal => ({ ...r, changes: JSON.parse(r.changes), before: r.before ? JSON.parse(r.before) : null, auto: !!r.auto });
export const listProposals = (projectId: number) => all('SELECT * FROM proposals WHERE project_id=? ORDER BY id DESC', projectId).map(toProposal);
const getProposal = (id: number) => { const r = get('SELECT * FROM proposals WHERE id=?', id); return r ? toProposal(r) : undefined; };

/** Check a proposed change against the level's allowed fields and sane values. Returns the cleaned change. */
export function validateChanges(level: Level, changes: Record<string, any>, p: Project): Record<string, any> {
  const out: Record<string, any> = {};
  const styleOk = new Set([...listStyles().map((s) => s.slug), ...skillStyles().map((s) => s.slug)]);
  for (const [k, v] of Object.entries(changes ?? {})) {
    if (!FIELDS[level].includes(k)) throw new Error(`“${k}” cannot be changed by a ${level}`);
    if (k === 'duration_sec') {
      const n = Number(v);
      if (!(n >= 10 && n <= 180) || Math.abs(n - p.duration_sec) > Math.max(15, p.duration_sec * 0.5)) throw new Error(`length ${v}s is out of range`);
      out[k] = Math.round(n);
    } else if (k === 'styles') {
      if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || (styleOk.size && !styleOk.has(s)))) throw new Error('unknown style in proposal');
      out[k] = v;
    } else if (k === 'post_times') {
      if (!Array.isArray(v) || !v.length || v.some((t) => !/^\d{1,2}:\d{2}$/.test(t))) throw new Error('bad posting times');
      out[k] = v;
    } else if (k === 'voice_name') {
      if (v && !VOICE_IDS.has(v)) throw new Error(`unknown voice ${v}`);
      out[k] = v || '';
    } else if (k === 'voice_speed') {
      const n = Number(v); if (!(n === 0 || (n >= 0.7 && n <= 1.3))) throw new Error('voice speed out of range');
      out[k] = n;
    } else {
      if (typeof v !== 'string' || v.length > 600) throw new Error(`bad value for ${k}`);
      out[k] = v.trim();
    }
  }
  if (!Object.keys(out).length) throw new Error('proposal changes nothing');
  return out;
}

function writeProject(projectId: number, changes: Record<string, any>) {
  const keys = Object.keys(changes);
  run(`UPDATE projects SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map((k) => Array.isArray(changes[k]) ? JSON.stringify(changes[k]) : changes[k]), projectId);
  changed('project', projectId);
}

export function applyProposal(id: number, auto = false) {
  const pr = getProposal(id);
  if (!pr) throw new Error('proposal not found');
  if (pr.status !== 'pending') throw new Error(`this proposal is already ${pr.status}`);
  const p = getProject(pr.project_id)!;
  const clean = validateChanges(pr.level, pr.changes, p);
  const before = Object.fromEntries(Object.keys(clean).map((k) => [k, (p as any)[k]]));
  writeProject(p.id, clean);
  run(`UPDATE proposals SET status='applied', before=?, auto=?, decided_at=? WHERE id=?`, JSON.stringify(before), auto ? 1 : 0, now(), id);
  changed('learning', p.id);
}
export function dismissProposal(id: number) {
  const pr = getProposal(id); if (!pr) throw new Error('proposal not found');
  if (pr.status !== 'pending') throw new Error(`this proposal is already ${pr.status}`);
  run(`UPDATE proposals SET status='dismissed', decided_at=? WHERE id=?`, now(), id);
  changed('learning', pr.project_id);
}
/** Put back what an applied change replaced (only fields nobody has changed since). */
export function undoProposal(id: number) {
  const pr = getProposal(id); if (!pr) throw new Error('proposal not found');
  if (pr.status !== 'applied' || !pr.before) throw new Error('only applied changes can be undone');
  const p = getProject(pr.project_id)!;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const back = Object.fromEntries(Object.entries(pr.before).filter(([k]) => same((p as any)[k], pr.changes[k])));
  if (Object.keys(back).length) writeProject(p.id, back);
  run(`UPDATE proposals SET status='undone', decided_at=? WHERE id=?`, now(), id);
  changed('learning', p.id);
}

/** How often the owner agreed with proposed shifts — shown next to the "Fully automatic" option. */
export function approvalStats(projectId: number) {
  const r = all<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM proposals WHERE project_id=? AND level IN ('shift','tweak') AND auto=0 AND status IN ('applied','dismissed','undone') GROUP BY status`, projectId);
  const n = (s: string) => r.find((x) => x.status === s)?.n ?? 0;
  return { approved: n('applied'), dismissed: n('dismissed') + n('undone') };
}

/** The rules: tweaks apply on their own when confident; shifts apply on their own only in "Fully automatic"; pivots always ask. */
function decide(projectId: number, raw: any[]) {
  const p = getProject(projectId)!;
  const out = { applied: [] as Proposal[], pending: [] as Proposal[], rejected: 0 };
  for (const x of raw.slice(0, 3)) {
    const level: Level = ['tweak', 'shift', 'pivot'].includes(x?.level) ? x.level : 'tweak';
    const confidence = ['low', 'medium', 'high'].includes(x?.confidence) ? x.confidence : 'low';
    let changes: Record<string, any>;
    try { changes = validateChanges(level, x?.changes, p); } catch (e: any) { console.warn(`[analyst] proposal dropped: ${e.message}`); out.rejected++; continue; }
    const r = run(`INSERT INTO proposals(project_id, level, title, reason, evidence, confidence, changes, status, created_at) VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
      projectId, level, String(x.title || 'Change').slice(0, 140), String(x.reason || ''), String(x.evidence || ''), confidence, JSON.stringify(changes), now());
    const id = Number(r.lastInsertRowid);
    const auto = (level === 'tweak' && confidence !== 'low') || (level === 'shift' && p.adapt_mode === 'auto' && confidence !== 'low');
    if (auto) { applyProposal(id, true); out.applied.push(getProposal(id)!); } else out.pending.push(getProposal(id)!);
  }
  return out;
}

// ─── The analyst run ─────────────────────────────────────────────────────────
const fmtChanges = (c: Record<string, any>) => Object.entries(c).map(([k, v]) => `${k.replace(/_/g, ' ')} → ${Array.isArray(v) ? v.join(', ') : v}`).join('; ');

export async function analyse(projectId: number) {
  const p = getProject(projectId); if (!p) throw new Error('project not found');
  const dir = learningDir(projectId); fs.mkdirSync(dir, { recursive: true });
  const job = startJob('analyst', projectId, dir);
  try {
    const data = buildDataset(projectId);
    fs.writeFileSync(path.join(dir, 'dataset.json'), JSON.stringify(data, null, 2));
    const previous = readPlaybook(projectId);
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(listProposals(projectId).slice(0, 30).map((x) => ({ level: x.level, title: x.title, changes: x.changes, status: x.status, auto: x.auto, at: x.decided_at ?? x.created_at })), null, 2));
    for (const f of ['proposals.json', 'playbook.md']) fs.rmSync(path.join(dir, f), { force: true });

    if (getSetting('mock_mode', false)) {
      const best = [...data.videos].sort((a, b) => (b.platforms.youtube?.latest?.views ?? 0) - (a.platforms.youtube?.latest?.views ?? 0))[0];
      fs.writeFileSync(path.join(dir, 'playbook.md'), `# Playbook (test mode)\n\nBest so far: ${best?.title ?? '—'}\n`);
      fs.writeFileSync(path.join(dir, 'playbook.json'), JSON.stringify({
        summary: 'Test-mode playbook.', data_quality: 'too little', unknowns: ['Everything, in test mode'], next_tests: ['Post at 19:00'],
        lessons: [...(previous?.lessons ?? []).filter((l) => l.status === 'pinned'), { id: 'L1', text: `Lean towards topics like “${best?.title ?? 'the best video'}”.`, evidence: 'test mode', confidence: 'low', status: 'active' }],
      }, null, 2));
      fs.writeFileSync(path.join(dir, 'proposals.json'), JSON.stringify([
        { level: 'tweak', title: 'Post in the evening', reason: 'test', evidence: 'test', confidence: 'medium', changes: { post_times: ['19:00'] } },
        { level: 'shift', title: 'Focus on timely discoveries', reason: 'test', evidence: 'test', confidence: 'medium', changes: { focus: 'Discoveries in the news this month' } },
      ]));
    } else {
      const styleOptions = [...listStyles().map((s) => s.slug), ...skillStyles().map((s) => s.slug)].join(', ') || 'any';
      const settings = JSON.stringify({ duration_sec: p.duration_sec, styles: p.styles, post_times: p.post_times, voice_name: p.voice_name, voice_speed: p.voice_speed, voice_style: p.voice_style, music_mood: p.music_mood });
      const note = data.measured < 10
        ? `**Data is thin: ${data.measured} measured video(s).** Keep every lesson at low confidence, propose no pivot, and propose a shift only if one pattern is unmistakable. Say plainly what more data is needed.`
        : '';
      const vars: Record<string, string> = {
        name: p.name, niche: p.niche, audience: p.audience || 'general', language: p.language, focus: p.focus || 'none set',
        settings, style_options: styleOptions, adapt_mode: p.adapt_mode === 'auto' ? 'fully automatic (shifts apply without asking)' : 'ask the owner before shifts', data_note: note,
      };
      const prompt = fs.readFileSync(path.join(PROMPTS_DIR, 'analyst.md'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
      const r = await jobClaude(job, { cwd: dir, prompt, tools: ['Read', 'Write', 'Glob'], timeoutMs: 20 * 60_000, model: modelFor('analyst'), addDirs: [path.join(PROJECTS_DIR, `p${projectId}`)] });
      if (!r.ok) { finishJob(job, 'failed', r.error); return null; }
    }

    // Merge with the owner's edits: pinned lessons stay, struck ones never come back.
    const pb: Playbook = readJson(path.join(dir, 'playbook.json')) ?? { lessons: [] };
    pb.lessons = Array.isArray(pb.lessons) ? pb.lessons.filter((l) => l?.id && l?.text) : [];
    for (const old of previous?.lessons ?? []) {
      const mine = pb.lessons.find((l) => l.id === old.id);
      if (old.status === 'struck') { if (mine) mine.status = 'struck'; else pb.lessons.push(old); }
      if (old.status === 'pinned') { if (mine) Object.assign(mine, { text: old.text, status: 'pinned' }); else pb.lessons.push(old); }
    }
    pb.updated_at = now();
    writePlaybook(projectId, pb);
    const raw = readJson(path.join(dir, 'proposals.json'));
    const result = decide(projectId, Array.isArray(raw) ? raw : []);
    run('UPDATE projects SET analyzed_at=? WHERE id=?', now(), projectId);

    addNote('playbook', `${p.name}: playbook updated`, `${pb.summary ?? ''}\n${pb.lessons.filter((l) => l.status !== 'struck').length} lesson(s) · data: ${pb.data_quality ?? 'unknown'}`, { link: `/learning/${projectId}`, mac: false });
    for (const a of result.applied) addNote('applied', `${p.name}: ${a.title}`, `Applied automatically (${a.level}, ${a.confidence} confidence): ${fmtChanges(a.changes)}\n${a.reason}`, { link: `/learning/${projectId}`, ref: `proposal:${a.id}` });
    for (const q of result.pending) addNote('proposal', `${p.name}: ${q.level} proposed — ${q.title}`, `${fmtChanges(q.changes)}\n${q.reason}`, { link: `/learning/${projectId}`, ref: `proposal:${q.id}` });
    finishJob(job, 'done');
    changed('learning', projectId);
    return { playbook: pb, ...result };
  } catch (e: any) { finishJob(job, 'failed', e.message); throw e; }
}

/** Due when a project has enough published videos and new measurements since its last analysis. */
export function analysisDue(p: Project): boolean {
  const published = get<{ n: number }>(`SELECT COUNT(DISTINCT v.id) n FROM videos v JOIN posts po ON po.video_id=v.id WHERE v.project_id=? AND po.status='published'`, p.id)!.n;
  if (published < MIN_PUBLISHED) return false;
  if (p.analyzed_at && Date.now() - new Date(p.analyzed_at).getTime() < MIN_GAP_HOURS * 3600_000) return false;
  const fresh = get<{ n: number }>(`SELECT COUNT(*) n FROM metrics m JOIN posts po ON po.id=m.post_id JOIN videos v ON v.id=po.video_id
    WHERE v.project_id=? AND m.checkpoint IN ('24h','3d','7d') AND m.taken_at > ?`, p.id, p.analyzed_at ?? '')!.n;
  return fresh > 0;
}

const requested = new Set<number>();
export function requestAnalysis(projectId: number) { requested.add(projectId); }
export const analysisRequested = (projectId: number) => requested.has(projectId);

export async function learningTick() {
  const ids = [...requested, ...all<{ id: number }>('SELECT id FROM projects WHERE active=1').map((r) => r.id)];
  for (const id of [...new Set(ids)]) {
    const p = getProject(id); if (!p) { requested.delete(id); continue; }
    if (!requested.has(id) && !analysisDue(p)) continue;
    const ran = await runSideJob(`analyst:${id}`, async () => { requested.delete(id); await analyse(id); });
    if (!ran) return;      // worker busy: try again on the next tick
  }
}
