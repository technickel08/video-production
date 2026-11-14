import fs from 'node:fs';
import { voiceBrief } from './voices.ts';
import { playbookText } from './learning.ts';
import { skillStyleText, styleInfo, extraSkillsText, STYLE_PREFIX } from './skills.ts';
import path from 'node:path';
import { all, getSetting, run, now, type Project, type Video } from './db.ts';
import { PROMPTS_DIR, SKILL_DIR, LIB_DIR, videoDir } from './paths.ts';
import { runClaude, describeEvent, type ClaudeResult } from './claude.ts';
import { probe, ffmpeg, loudness } from './tools.ts';
import { styleListText, listStyles } from './styles.ts';
import { logLine } from './events.ts';

export interface StageCtx {
  video: Video;
  project: Project;
  dir: string;
  logPath: string;
  log: (text: string) => void;
}
export interface StageResult extends Partial<ClaudeResult> {
  ok: boolean;
  /** Check stage: go back to produce with these issues. */
  redo?: string[];
  error?: string;
}

const RESOLUTION: Record<string, string> = {
  '9:16': '1080×1920', '16:9': '1920×1080', '1:1': '1080×1080', '4:5': '1080×1350',
};
const mock = () => getSetting('mock_mode', false);
const yes = (b: boolean) => (b ? 'yes' : 'no');

function template(name: string, vars: Record<string, string | number>) {
  const t = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return t.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
}

function projectVars(p: Project, v: Video) {
  return {
    name: p.name, niche: p.niche, audience: p.audience || 'general', language: p.language, format: p.format,
    duration_sec: p.duration_sec, aspect_ratio: p.aspect_ratio, notes: p.notes || 'none',
    voice: voiceBrief(p), music: p.music ? (p.music_mood.trim() ? `yes — mood: ${p.music_mood.trim()}` : 'yes') : 'no', captions: yes(p.captions),
    styles: p.styles.length ? p.styles.join(', ') : 'any',
    focus: p.focus.trim() ? `- Current focus for this channel (chosen from past results): ${p.focus.trim()} — prefer topics within it.` : '',
    revision: v.note ? `## Revision requested\nThe previous attempt was not accepted. Fix these points:\n${v.note}\n` : '',
  };
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function claude(ctx: StageCtx, prompt: string, tools: string[], timeoutMs: number, extra: { addDirs?: string[]; model?: string } = {}) {
  return runClaude({
    cwd: ctx.dir, prompt, tools, logPath: ctx.logPath, timeoutMs, ...extra,
    // A model chosen for this step in Settings wins over the general one.
    model: extra.model || getSetting<string>(`model_${ctx.video.stage}`, '') || undefined,
    onEvent: (e) => { const t = describeEvent(e); if (t) logLine(ctx.video.id, ctx.video.stage, t); },
  });
}

// ─── Research ────────────────────────────────────────────────────────────────
async function research(ctx: StageCtx): Promise<StageResult> {
  const { project: p, video: v, dir } = ctx;
  const past = all<{ topic: string }>(`SELECT topic FROM videos WHERE project_id=? AND id<>? AND topic<>'' ORDER BY id DESC LIMIT 60`, p.id, v.id);
  if (mock()) {
    ctx.log('Mock mode: writing sample research');
    const topic = `Sample topic #${v.id} about ${p.niche || 'the niche'}`;
    fs.writeFileSync(path.join(dir, 'research.md'), `# Research\n\n**Chosen:** ${topic}\n\n- Idea 1 — 8/10\n- Idea 2 — 7/10\n\nSources: https://example.com\n`);
    fs.writeFileSync(path.join(dir, 'topics.json'), JSON.stringify({ chosen: { topic, angle: 'Surprising fact', working_title: topic, why: 'mock' }, ideas: [], facts: [] }, null, 2));
  } else {
    const prompt = template('research', { ...projectVars(p, v), performance: playbookText(p.id), past_topics: past.map((x) => `- ${x.topic}`).join('\n') || '- none yet' });
    const r = await claude(ctx, prompt, ['WebSearch', 'WebFetch', 'Read', 'Write'], 20 * 60_000);
    if (!r.ok) return r;
  }
  const topics = readJson(path.join(dir, 'topics.json'));
  if (!topics?.chosen?.topic) return { ok: false, error: 'research did not produce topics.json with a chosen topic' };
  run('UPDATE videos SET topic=?, title=?, updated_at=? WHERE id=?', topics.chosen.topic, topics.chosen.working_title || topics.chosen.topic, now(), v.id);
  return { ok: true };
}

// ─── Script ──────────────────────────────────────────────────────────────────
async function script(ctx: StageCtx): Promise<StageResult> {
  const { project: p, video: v, dir } = ctx;
  if (mock()) {
    ctx.log('Mock mode: writing sample script');
    fs.writeFileSync(path.join(dir, 'script.md'), `# ${v.topic}\n\n| Time | Narration | Visuals |\n|---|---|---|\n| 0–3s | Hook line | Bold title |\n| 3–${p.duration_sec}s | Body | Animation |\n`);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
      title: v.topic.slice(0, 90), description: `A short video about ${v.topic}.`, hashtags: ['#shorts', '#learn'],
      style: p.styles[0] || listStyles()[0]?.slug || 'swiss-motion', thumbnail_text: 'Did you know?', narration_words: 100,
    }, null, 2));
  } else {
    // "Try it on my next video": this video uses the chosen skill; otherwise the project's styles plus added skills.
    const forced = p.next_style && (p.next_style.startsWith(STYLE_PREFIX) ? skillStyleText([p.next_style]) : styleListText([p.next_style]));
    const styleList = forced || [styleListText(p.styles.filter((s) => !s.startsWith(STYLE_PREFIX))), skillStyleText(p.styles)].filter(Boolean).join('\n');
    const vars = { ...projectVars(p, v), ...(forced ? { styles: p.next_style! } : {}), style_list: styleList, performance: playbookText(p.id) };
    const r = await claude(ctx, template('script', vars), ['Read', 'Write'], 15 * 60_000);
    if (!r.ok) return r;
    // An independent editor scores the hook and title; a weak one is rewritten once before anyone sees it.
    const platforms = all<{ platform: string }>('SELECT DISTINCT c.platform FROM channels c JOIN project_channels pc ON pc.channel_id=c.id WHERE pc.project_id=?', p.id).map((x) => x.platform).join(' and ') || 'YouTube and Instagram';
    for (let attempt = 0; attempt < 2; attempt++) {
      fs.rmSync(path.join(dir, 'hook.json'), { force: true });
      const j = await claude(ctx, template('hook', { ...vars, platforms }), ['Read', 'Write'], 5 * 60_000, { model: 'haiku' });
      if (!j.ok) { if (j.usageLimited) return j; ctx.log('Hook check could not run; continuing without it'); break; }
      const h = readJson(path.join(dir, 'hook.json'));
      if (!h) { ctx.log('Hook check wrote no result; continuing without it'); break; }
      ctx.log(`Hook ${h.hook_score}/10, title ${h.title_score}/10${h.pass ? ' — pass' : ''}`);
      if (h.pass || attempt === 1) break;
      ctx.log('Hook or title too weak — rewriting the script once');
      const fix = [`## Editor's verdict on your first draft (hook ${h.hook_score}/10, title ${h.title_score}/10)`, 'Rewrite `script.md` and `metadata.json` in place. Keep the topic, facts and style; fix these:',
        ...(h.issues ?? []).map((i: string) => `- ${i}`),
        h.better_hooks?.length ? `Hook ideas (use or beat them): ${h.better_hooks.join(' | ')}` : '', h.better_titles?.length ? `Title ideas: ${h.better_titles.join(' | ')}` : ''].filter(Boolean).join('\n');
      const r2 = await claude(ctx, template('script', { ...vars, revision: `${vars.revision}\n${fix}\n` }), ['Read', 'Write'], 15 * 60_000);
      if (!r2.ok) return r2;
    }
  }
  const meta = readJson(path.join(dir, 'metadata.json'));
  if (!meta?.title || !meta?.style) return { ok: false, error: 'script did not produce a valid metadata.json (title and style are required)' };
  run('UPDATE videos SET title=?, updated_at=? WHERE id=?', String(meta.title).slice(0, 120), now(), v.id);
  // Record how this video was made, so the analyst can compare like with like later.
  meta.made_with = { voice_name: p.voice_name || 'auto', voice_speed: p.voice_speed || 'auto', voice_style: p.voice_style, music_mood: p.music_mood,
    target_sec: p.duration_sec, focus: p.focus, production_step: p.production_step, trial: !!p.next_style };
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
  if (p.next_style) run('UPDATE projects SET next_style=NULL WHERE id=?', p.id);
  return { ok: true };
}

// ─── Production design ───────────────────────────────────────────────────────
async function production(ctx: StageCtx): Promise<StageResult> {
  const { project: p, video: v, dir } = ctx;
  const meta = readJson(path.join(dir, 'metadata.json')) || {};
  if (mock()) {
    ctx.log('Mock mode: writing a sample production bible');
    fs.writeFileSync(path.join(dir, 'production.md'), `# Production — ${v.title || v.topic}\n\n## Look\nWarm, hand-drawn.\n\n| Colour | Hex | Use |\n|---|---|---|\n| Saffron | #E8912D | Hero |\n| Indigo | #27306B | Night |\n\n## Cast\n| Role | Look | Costume |\n|---|---|---|\n| Narrator figure | Tall, calm | Indigo robe |\n\n## Scenes\n| # | Time | Set | Action |\n|---|---|---|---|\n| 1 | 0–3s | Court | Hook |\n`);
    fs.writeFileSync(path.join(dir, 'production.json'), JSON.stringify({ palette: [{ name: 'Saffron', hex: '#E8912D', use: 'Hero' }], cast: [], sets: [], scenes: [{ n: 1, time: '0–3s', set: 'Court', cast: [], action: 'Hook' }], rules: [] }, null, 2));
  } else {
    const info = styleInfo(meta.style || 'any');
    const prompt = template('production', { ...projectVars(p, v), style: meta.style || 'any', style_label: info.label, style_rules: info.rules, lib_dir: LIB_DIR, performance: playbookText(p.id) });
    const r = await claude(ctx, prompt, ['Read', 'Write', 'Glob'], 15 * 60_000, { addDirs: [LIB_DIR, ...(info.skill?.path ? [info.skill.path] : [])] });
    if (!r.ok) return r;
  }
  const bible = path.join(dir, 'production.md');
  if (!fs.existsSync(bible) || fs.statSync(bible).size < 200) return { ok: false, error: 'production did not write production.md' };
  return { ok: true };
}

// ─── Produce ─────────────────────────────────────────────────────────────────
function findFilm(filmDir: string): string | null {
  const preferred = path.join(filmDir, 'film.mp4');
  if (fs.existsSync(preferred)) return preferred;
  const found: { f: string; t: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.name.endsWith('.mp4')) found.push({ f, t: fs.statSync(f).mtimeMs });
    }
  };
  walk(filmDir, 0);
  return found.sort((a, b) => b.t - a.t)[0]?.f ?? null;
}

/** When the film folder already holds work, tell Claude to build on it instead of starting again. */
function resumeNote(filmDir: string, revising: boolean): string {
  const entries = fs.existsSync(filmDir) ? fs.readdirSync(filmDir).filter((f) => !f.startsWith('.') && f !== 'node_modules') : [];
  if (!entries.length) return '';
  const finished = entries.includes('film.mp4');
  if (finished && revising) return `## Revise, do not rebuild
The film in \`${filmDir}\` is complete. Change only what the fix list above needs: edit the affected scenes, re-render only those, then rebuild the final file and re-run the checks. Reuse the voice lines, music and every other scene exactly as they are. Do not re-read the guides unless a fix needs them.
`;
  if (finished) return '';   // a finished film redone without feedback is a fresh attempt
  return `## Continue, do not restart
An earlier run of this step was interrupted partway. \`${filmDir}\` already holds its work (${entries.slice(0, 12).join(', ')}${entries.length > 12 ? ', …' : ''}).
Before anything else, list that folder and read its treatment and storyboard to see how far it got. Keep every finished piece — treatment, storyboard, scene code, voice lines, music, rendered scenes — and continue from the first unfinished one. Tools and packages are already installed. Read only the parts of the guides you need for the remaining work, and do not regenerate anything that already exists and is fine.
`;
}

async function produce(ctx: StageCtx): Promise<StageResult> {
  const { project: p, video: v, dir } = ctx;
  const filmDir = path.join(dir, 'film');
  fs.mkdirSync(filmDir, { recursive: true });
  run('UPDATE videos SET produce_attempts=produce_attempts+1 WHERE id=?', v.id);
  const meta = readJson(path.join(dir, 'metadata.json')) || {};

  if (mock()) {
    ctx.log('Mock mode: rendering a test-pattern video');
    const [w, h] = (RESOLUTION[p.aspect_ratio] || '1080×1920').split('×').map((n) => Math.round(Number(n) / 2 / 2) * 2);
    const d = String(p.duration_sec);
    await ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=24:duration=${d}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${d}`,
      '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(filmDir, 'film.mp4')]);
    await ffmpeg(['-ss', '1', '-i', path.join(filmDir, 'film.mp4'), '-frames:v', '1', path.join(filmDir, 'poster.jpg')]);
    fs.writeFileSync(path.join(filmDir, 'TREATMENT.md'), `# Treatment (mock)\n\nStyle: ${meta.style}\n`);
  } else {
    const info = styleInfo(meta.style || 'any');
    const extra = extraSkillsText(p.extra_skills);
    const prompt = template(info.skill ? 'produce-skill' : 'produce', {
      ...projectVars(p, v), style: meta.style || 'any', skill_dir: info.skill?.path ?? SKILL_DIR, lib_dir: LIB_DIR,
      skill_name: info.skill?.name ?? 'lemo-opuscar', skill_source: info.skill?.repo ?? '', skill_version: info.skill?.ref?.slice(0, 7) ?? '',
      extra_skills: extra.text,
      film_dir: filmDir, video_dir: dir, resolution: RESOLUTION[p.aspect_ratio] || p.aspect_ratio,
      resume: resumeNote(filmDir, !!v.note),
      production: p.production_step && fs.existsSync(path.join(dir, 'production.md'))
        ? `- Production design: read \`${path.join(dir, 'production.md')}\` (data in \`production.json\`) and follow it — palette, cast and costumes, sets, the scene list and the continuity rules. The owner approved it; depart from it only where the style's own rules make something impossible, and say so in the treatment.`
        : '',
    });
    const r = await claude(ctx, prompt, ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'],
      getSetting('produce_timeout_min', 180) * 60_000, { addDirs: [info.skill?.path ?? SKILL_DIR, LIB_DIR, ...extra.dirs] });
    if (!r.ok) return r;
  }

  const film = findFilm(filmDir);
  if (!film) return { ok: false, error: 'the skill finished but no .mp4 was found in the film folder' };
  fs.copyFileSync(film, path.join(dir, 'final.mp4'));
  const poster = path.join(filmDir, 'poster.jpg');
  if (fs.existsSync(poster)) fs.copyFileSync(poster, path.join(dir, 'poster.jpg'));
  else await ffmpeg(['-ss', '1', '-i', film, '-frames:v', '1', path.join(dir, 'poster.jpg')]).catch(() => {});
  const srt = [path.join(filmDir, 'film.srt'), film.replace(/\.mp4$/, '.srt')].find((f) => fs.existsSync(f));
  if (srt) fs.copyFileSync(srt, path.join(dir, 'captions.srt'));
  ctx.log(`Film ready: ${path.relative(dir, film)}`);
  return { ok: true };
}

// ─── Check ───────────────────────────────────────────────────────────────────
async function check(ctx: StageCtx): Promise<StageResult> {
  const { project: p, dir } = ctx;
  const file = path.join(dir, 'final.mp4');
  if (!fs.existsSync(file)) return { ok: false, error: 'final.mp4 is missing' };

  const info = await probe(file);
  const vs = info.width && info.height ? { width: info.width, height: info.height } : null;
  const { hasAudio, duration } = info;
  const lufs = hasAudio ? await loudness(file) : null;
  const [aw, ah] = p.aspect_ratio.split(':').map(Number);
  const checks = [
    { name: 'Video stream', ok: !!vs, detail: vs ? `${vs.width}×${vs.height}` : 'missing' },
    { name: 'Length', ok: duration >= p.duration_sec * 0.75 && duration <= p.duration_sec * 1.35, detail: `${duration.toFixed(1)}s (target ${p.duration_sec}s)` },
    { name: 'Aspect ratio', ok: !!vs && Math.abs(vs.width / vs.height - aw / ah) < 0.02, detail: vs ? `${vs.width}:${vs.height} vs ${p.aspect_ratio}` : '' },
    { name: 'Audio', ok: hasAudio || (!p.voice && !p.music), detail: hasAudio ? 'present' : 'none' },
    { name: 'Loudness', ok: lufs === null ? !hasAudio : lufs > -22 && lufs < -8, detail: lufs === null ? 'n/a' : `${lufs.toFixed(1)} LUFS (aim −14)` },
  ];
  const techPass = checks.every((c) => c.ok);

  if (vs && duration > 0) {
    await ffmpeg(['-i', file, '-vf', `fps=9/${duration.toFixed(2)},scale=360:-2,tile=3x3`, '-frames:v', '1', '-q:v', '4', path.join(dir, 'grid.jpg')]).catch((e) => ctx.log(`Contact sheet failed: ${e.message}`));
  }
  if (vs && duration > 0) {
    // Six frames from the first three seconds, so the reviewer can judge the opening.
    await ffmpeg(['-t', '3', '-i', file, '-vf', 'fps=2,scale=360:-2,tile=6x1', '-frames:v', '1', '-q:v', '4', path.join(dir, 'hook.jpg')]).catch(() => {});
  }
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify({ pass: techPass, duration, width: vs?.width, height: vs?.height, audio: hasAudio, lufs, checks }, null, 2));
  for (const c of checks) ctx.log(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  if (!techPass) return { ok: true, redo: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) };

  if (mock()) {
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ pass: true, score: 7, issues: [], summary: 'Mock review: passed.' }, null, 2));
  } else {
    const platforms = all<{ platform: string }>('SELECT DISTINCT c.platform FROM channels c JOIN project_channels pc ON pc.channel_id=c.id WHERE pc.project_id=?', p.id).map((x) => x.platform);
    const r = await claude(ctx, template('review', { platforms: platforms.join(' and ') || 'YouTube and Instagram' }), ['Read', 'Write'], 10 * 60_000);
    if (!r.ok) return r;
  }
  const review = readJson(path.join(dir, 'review.json'));
  if (!review) return { ok: false, error: 'review did not write review.json' };
  ctx.log(`Review: ${review.pass ? 'pass' : 'fail'} (${review.score}/10) — ${review.summary ?? ''}`);
  if (!review.pass) return { ok: true, redo: review.issues?.length ? review.issues : ['Reviewer rejected the video'] };
  return { ok: true };
}

export const RUNNERS: Record<string, (ctx: StageCtx) => Promise<StageResult>> = { research, script, production, produce, check };

export function makeCtx(video: Video, project: Project, runId: number): StageCtx {
  const dir = videoDir(project.id, video.id);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const logPath = path.join(dir, 'logs', `${video.stage}-${runId}.jsonl`);
  return {
    video, project, dir, logPath,
    log: (text) => {
      fs.appendFileSync(logPath, JSON.stringify({ type: 'note', text, at: new Date().toISOString() }) + '\n');
      logLine(video.id, video.stage, text);
    },
  };
}
