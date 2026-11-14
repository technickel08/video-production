import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all, get, run, now, getSetting, setSetting, getProject } from './db.ts';
import { DATA_DIR, LIB_DIR, PROMPTS_DIR, SKILL_DIR } from './paths.ts';
import { listStyles } from './styles.ts';
import { addNote } from './inbox.ts';
import { changed } from './events.ts';
import { runSideJob } from './pipeline.ts';
import { startJob, finishJob, jobClaude, modelFor } from './jobs.ts';

const pexec = promisify(execFile);
export const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const SCOUT_DIR = path.join(DATA_DIR, 'scout');
const GH_API = () => process.env.GITHUB_API_BASE || 'https://api.github.com';
const GH_CODELOAD = () => process.env.GITHUB_CODELOAD_BASE || 'https://codeload.github.com';
const MAX_DOWNLOAD = 300 * 1024 * 1024;

export type SkillKind = 'visual' | 'voice' | 'music' | 'captions' | 'other';
export interface Card {
  summary?: string; makes_full_video?: boolean; better_because?: string; sample_url?: string; runs?: string; network?: string;
  needs_keys?: string[]; license?: string; last_commit?: string; stars?: number; risk?: 'low' | 'medium' | 'high'; risk_notes?: string;
  recommendation?: 'add' | 'watch' | 'skip';
}
export interface Skill {
  id: number; slug: string; name: string; kind: SkillKind; repo: string; subpath: string; ref: string | null; card: Card;
  status: 'found' | 'installed' | 'dismissed' | 'removed' | 'skipped'; path: string | null; found_at: string; installed_at: string | null;
}
const toSkill = (r: any): Skill => ({ ...r, card: JSON.parse(r.card || '{}') });
export const listSkills = () => all('SELECT * FROM skills ORDER BY id DESC').map(toSkill);
export const getSkill = (id: number) => { const r = get('SELECT * FROM skills WHERE id=?', id); return r ? toSkill(r) : undefined; };
export const installedSkills = (kind?: SkillKind) =>
  all(`SELECT * FROM skills WHERE status='installed' ${kind ? 'AND kind=?' : ''} ORDER BY name`, ...(kind ? [kind] : [])).map(toSkill)
    .filter((s) => s.path && fs.existsSync(path.join(s.path, 'SKILL.md')));

// ─── Skills as visual styles ─────────────────────────────────────────────────
export const STYLE_PREFIX = 'skill:';
export const skillStyles = () => installedSkills('visual').map((s) => ({ slug: `${STYLE_PREFIX}${s.slug}`, name: s.name, category: 'Other skills' }));
const skillForStyle = (style: string) => style.startsWith(STYLE_PREFIX) ? installedSkills('visual').find((s) => `${STYLE_PREFIX}${s.slug}` === style) : undefined;

/** Added visual skills, as extra options in the script step's style list. */
export function skillStyleText(allowed: string[]): string {
  return installedSkills('visual').filter((s) => !allowed.length || allowed.includes(`${STYLE_PREFIX}${s.slug}`))
    .map((s) => `- \`${STYLE_PREFIX}${s.slug}\` — ${s.name}: ${s.card.summary ?? 'an added video skill'} (a separate skill, not a Lemo-Opuscar style)`).join('\n');
}

/** What the production and video steps need to know about the chosen style. */
export function styleInfo(style: string) {
  const s = skillForStyle(style);
  if (s) return {
    skill: s, label: `the “${s.name}” skill (\`${style}\`)`,
    rules: `This film is made with the ${s.name} skill. Read \`${s.path}/SKILL.md\` (and any guide it points to) and design only what that skill can actually make. Do not change the skill.`,
  };
  return {
    skill: undefined, label: `\`${style}\` (a Lemo-Opuscar style)`,
    rules: `Read the style's rules at \`${LIB_DIR}/styles/${style}/STYLE.md\` (and its README if there is one) so that everything you design can actually be drawn in that style. Do not change the style.`,
  };
}

/** Non-visual skills a project has switched on (voice, music, captions…), for the video step. */
export function extraSkillsText(slugs: string[]): { text: string; dirs: string[] } {
  const list = installedSkills().filter((s) => s.kind !== 'visual' && slugs.includes(s.slug));
  return {
    text: list.length ? `- Extra skills you may use for their part of the job (read each one's SKILL.md first): ${list.map((s) => `${s.name} (${s.kind}) at \`${s.path}\``).join('; ')}.` : '',
    dirs: list.map((s) => s.path!),
  };
}

// ─── Install / remove ────────────────────────────────────────────────────────
export function parseRepo(url: string): { owner: string; repo: string } {
  const m = String(url).trim().match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!m || m[1].startsWith('.') || m[2].startsWith('.')) throw new Error(`Only public GitHub repositories can be added (got “${url}”).`);
  return { owner: m[1], repo: m[2] };
}
function cleanSubpath(p: string): string {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((x) => x === '..' || x === '.' || !/^[A-Za-z0-9_.@ -]+$/.test(x))) throw new Error(`Unsafe folder path “${p}”.`);
  return parts.join('/');
}
const slugify = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'skill';

/** Download the exact commit, check it has a SKILL.md, and keep it in data/skills/<slug>@<sha>. Nothing in it is run here. */
export async function installSkill(id: number): Promise<Skill> {
  const s = getSkill(id);
  if (!s) throw new Error('skill not found');
  if (s.status === 'installed' && s.path && fs.existsSync(s.path)) return s;
  const { owner, repo } = parseRepo(s.repo);
  const sub = cleanSubpath(s.subpath);
  let sha = /^[0-9a-f]{40}$/.test(s.ref ?? '') ? s.ref! : '';
  if (!sha) {
    const r = await fetch(`${GH_API()}/repos/${owner}/${repo}/commits/${encodeURIComponent(s.ref || 'HEAD')}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'video-autopilot' } });
    if (!r.ok) throw new Error(`Could not find that repository's latest version on GitHub (${r.status}).`);
    sha = String((await r.json()).sha || '');
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub did not return a version to pin.');
  }
  const res = await fetch(`${GH_CODELOAD()}/${owner}/${repo}/tar.gz/${sha}`, { headers: { 'user-agent': 'video-autopilot' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error('That repository is too large to add (over 300 MB).');

  const tmp = path.join(SKILLS_DIR, `.tmp-${s.slug}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    fs.writeFileSync(path.join(tmp, 'src.tar.gz'), buf);
    fs.mkdirSync(path.join(tmp, 'x'));
    // tar refuses absolute paths and ".." entries by default, so the archive cannot write outside tmp/x.
    await pexec('tar', ['-xzf', path.join(tmp, 'src.tar.gz'), '-C', path.join(tmp, 'x')]);
    const top = fs.readdirSync(path.join(tmp, 'x'));
    if (top.length !== 1) throw new Error('Unexpected archive layout.');
    const src = path.join(tmp, 'x', top[0], sub);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`No SKILL.md in ${sub || 'the repository root'} at that version.`);
    const dest = path.join(SKILLS_DIR, `${s.slug}@${sha.slice(0, 7)}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(src, dest);
    run(`UPDATE skills SET status='installed', path=?, ref=?, installed_at=? WHERE id=?`, dest, sha, now(), id);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const done = getSkill(id)!;
  addNote('skill_added', `Skill added: ${done.name}`,
    done.kind === 'visual' ? 'It now appears under Project → Visual style → Other skills.' : `It can be switched on per project under Sound (${done.kind}).`,
    { link: '/skills', ref: `skill:${id}` });
  changed('skills');
  return done;
}

export function removeSkill(id: number) {
  const s = getSkill(id); if (!s) return;
  if (s.path && s.path.startsWith(SKILLS_DIR + path.sep)) fs.rmSync(s.path, { recursive: true, force: true });
  run(`UPDATE skills SET status='removed', path=NULL WHERE id=?`, id);
  for (const p of all<{ id: number; styles: string; extra_skills: string; next_style: string | null }>('SELECT id, styles, extra_skills, next_style FROM projects')) {
    const styles = (JSON.parse(p.styles) as string[]).filter((x) => x !== `${STYLE_PREFIX}${s.slug}`);
    const extra = (JSON.parse(p.extra_skills || '[]') as string[]).filter((x) => x !== s.slug);
    run('UPDATE projects SET styles=?, extra_skills=?, next_style=? WHERE id=?', JSON.stringify(styles), JSON.stringify(extra),
      p.next_style === `${STYLE_PREFIX}${s.slug}` ? null : p.next_style, p.id);
  }
  changed('skills');
}
export function dismissSkill(id: number) { run(`UPDATE skills SET status='dismissed' WHERE id=? AND status='found'`, id); changed('skills'); }

/** Make the next video of a project with this skill, to compare it before using it widely. */
export function trySkill(id: number, projectId: number) {
  const s = getSkill(id);
  if (!s || s.status !== 'installed') throw new Error('Add the skill first.');
  if (s.kind !== 'visual') throw new Error('Only visual skills can be tried as a video style; switch other kinds on under the project’s Sound settings.');
  if (!getProject(projectId)) throw new Error('project not found');
  run('UPDATE projects SET next_style=? WHERE id=?', `${STYLE_PREFIX}${s.slug}`, projectId);
  changed('project', projectId);
}

// ─── Scout ───────────────────────────────────────────────────────────────────
function scoutContext() {
  const per = all<{ stage: string; n: number; cost: number }>(`SELECT stage, COUNT(DISTINCT video_id) n, SUM(cost_usd) cost FROM stage_runs WHERE cost_usd IS NOT NULL GROUP BY stage`);
  const fails = all<{ stage: string; n: number }>(`SELECT stage, COUNT(*) n FROM stage_runs WHERE status='failed' GROUP BY stage`);
  const redo = get<{ n: number }>(`SELECT COUNT(*) n FROM stage_runs WHERE stage='produce'`)!.n - get<{ n: number }>(`SELECT COUNT(DISTINCT video_id) n FROM stage_runs WHERE stage='produce'`)!.n;
  const mins = get<{ m: number }>(`SELECT AVG((julianday(finished_at)-julianday(started_at))*1440) m FROM stage_runs WHERE stage='produce' AND status='done'`)!.m;
  const usage = per.length
    ? per.map((x) => `- ${x.stage}: about $${(x.cost / Math.max(1, x.n)).toFixed(2)} of usage per video (API-price estimate)`).join('\n')
      + `\n- Video step takes about ${Math.round(mins || 0)} minutes; ${redo} extra video-step runs were needed after failed checks or stops.`
      + (fails.length ? `\n- Failed runs by step: ${fails.map((f) => `${f.stage} ${f.n}`).join(', ')}` : '')
    : '- No videos made yet.';
  const current = [
    `- Visual: the lemo-opuscar skill (${SKILL_DIR}) with ${listStyles().length} styles (motion graphics, illustration, paper-craft, documentary looks), rendered with headless Chrome and ffmpeg.`,
    '- Voice: Kokoro (offline TTS) and edge-tts; music: generated in the skill; captions: burned in by the skill.',
    ...installedSkills().map((s) => `- Added: ${s.name} (${s.kind}) from ${s.repo}`),
  ].join('\n');
  const known = listSkills().map((s) => `- ${s.repo}${s.subpath ? `/${s.subpath}` : ''} (${s.status})`).join('\n') || '- none';
  return { usage, current, known };
}

export const scoutDue = () => {
  if (!getSetting('scout_enabled', true)) return false;
  const last = getSetting<string | null>('scout_last_run', null);
  return !last || Date.now() - new Date(last).getTime() > getSetting('scout_every_days', 14) * 86400_000;
};

/** Search the web for better video skills (with Opus by default), vet them, and announce new finds. */
export async function runScout(): Promise<{ found: number }> {
  const dir = path.join(SCOUT_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const job = startJob('scout', null, dir);
  setSetting('scout_last_run', now());
  try {
    if (getSetting('mock_mode', false)) {
      fs.writeFileSync(path.join(dir, 'report.md'), '# Skill scout (test mode)\n\nOne sample find.\n');
      fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify([{
        slug: 'demo-video-skill', name: 'Demo video skill', kind: 'visual', repo: process.env.SCOUT_MOCK_REPO || 'https://github.com/example/video-skill',
        subpath: 'skills/demo', ref: '', summary: 'Sample finding written in test mode.', makes_full_video: true, risk: 'low', recommendation: 'add', needs_keys: [], license: 'MIT',
      }], null, 2));
    } else {
      const c = scoutContext();
      const prompt = fs.readFileSync(path.join(PROMPTS_DIR, 'scout.md'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => ({
        platform: process.platform === 'darwin' ? 'macOS' : 'Linux', today: new Date().toISOString().slice(0, 10), ...c,
      } as Record<string, string>)[k] ?? '');
      const r = await jobClaude(job, { cwd: dir, prompt, tools: ['WebSearch', 'WebFetch', 'Read', 'Write'], timeoutMs: 40 * 60_000, model: modelFor('scout', 'opus') });
      if (!r.ok) { finishJob(job, 'failed', r.error); return { found: 0 }; }
    }
    let findings: any[] = [];
    try { findings = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8')); } catch {}
    if (!Array.isArray(findings)) findings = [];
    fs.copyFileSync(path.join(dir, 'report.md'), path.join(SCOUT_DIR, 'latest.md'));

    let found = 0;
    for (const f of findings.slice(0, 12)) {
      try {
        parseRepo(f.repo); const sub = cleanSubpath(f.subpath ?? '');
        const repo = String(f.repo).replace(/\.git$|\/$/g, '');
        if (get('SELECT 1 FROM skills WHERE repo=? AND subpath=?', repo, sub)) continue;
        const kind: SkillKind = ['visual', 'voice', 'music', 'captions'].includes(f.kind) ? f.kind : 'other';
        let slug = slugify(f.slug || f.name || repo.split('/').pop()!);
        for (let i = 2; get('SELECT 1 FROM skills WHERE slug=?', slug); i++) slug = `${slugify(f.slug || f.name)}-${i}`;
        const rec = ['add', 'watch', 'skip'].includes(f.recommendation) ? f.recommendation : 'watch';
        const card: Card = {
          summary: f.summary, makes_full_video: !!f.makes_full_video, better_because: f.better_because, sample_url: f.sample_url, runs: f.runs,
          network: f.network, needs_keys: Array.isArray(f.needs_keys) ? f.needs_keys : [], license: f.license, last_commit: f.last_commit,
          stars: Number(f.stars) || undefined, risk: ['low', 'medium', 'high'].includes(f.risk) ? f.risk : 'medium', risk_notes: f.risk_notes, recommendation: rec,
        };
        const r = run('INSERT INTO skills(slug, name, kind, repo, subpath, ref, card, status, found_at) VALUES (?,?,?,?,?,?,?,?,?)',
          slug, String(f.name || slug).slice(0, 80), kind, repo, sub, /^[0-9a-f]{40}$/.test(f.ref ?? '') ? f.ref : null, JSON.stringify(card), rec === 'skip' ? 'skipped' : 'found', now());
        if (rec !== 'skip') {
          found++;
          addNote('skill_found', `New ${kind} skill found: ${String(f.name || slug).slice(0, 60)}`,
            `${card.summary ?? ''}${card.better_because ? `\nWhy: ${card.better_because}` : ''}\nRisk: ${card.risk}${card.needs_keys?.length ? ` · needs ${card.needs_keys.join(', ')}` : ''} · scout says: ${rec}`,
            { link: '/skills', ref: `skill:${Number(r.lastInsertRowid)}` });
        }
      } catch (e: any) { console.warn('[scout] skipped a finding:', e.message); }
    }
    if (!found) addNote('scout', 'Skill scout: nothing new worth adding', 'The full report is on the Skills page.', { link: '/skills', mac: false });
    finishJob(job, 'done');
    changed('skills');
    return { found };
  } catch (e: any) { finishJob(job, 'failed', e.message); throw e; }
}

export const latestScoutReport = () => { try { return fs.readFileSync(path.join(SCOUT_DIR, 'latest.md'), 'utf8'); } catch { return ''; } };

let scoutRequested = false;
export function requestScout() { scoutRequested = true; }
export async function scoutTick() {
  if (!scoutRequested && !scoutDue()) return;
  const ran = await runSideJob('scout', async () => { scoutRequested = false; await runScout(); });
  if (ran) return;
}
