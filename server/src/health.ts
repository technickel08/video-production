import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { findClaude, runClaude } from './claude.ts';
import { getSetting, setSetting } from './db.ts';
import { which, toolPath, systemFfmpeg } from './tools.ts';
import { LIB_DIR, SKILL_DIR, DATA_DIR } from './paths.ts';
import { PUBLISHERS } from './publish.ts';
import { changed } from './events.ts';
import { bin as cloudflaredBin } from 'cloudflared';

const pexec = promisify(execFile);

export interface Check { id: string; label: string; ok: boolean; detail: string; fix?: string; needed: string; }

async function version(cmd: string, args: string[]) {
  try { const { stdout, stderr } = await pexec(cmd, args, { env: { ...process.env, PATH: toolPath() }, timeout: 15_000 }); return (stdout || stderr).trim().split('\n')[0]; }
  catch { return null; }
}

function libPackages() {
  const sig = (files: string[]) => fs.existsSync(files[0]);
  return {
    core: sig([path.join(LIB_DIR, 'node_modules/.lemo-ok')]) && fs.existsSync(path.join(LIB_DIR, '.venv/.lemo-core')),
    voice: fs.existsSync(path.join(LIB_DIR, '.venv/.lemo-voice')) && fs.existsSync(path.join(LIB_DIR, 'core/tts/kokoro-v1.0.onnx')),
    music: fs.existsSync(path.join(LIB_DIR, '.venv/.lemo-music')),
  };
}

export async function health(): Promise<Check[]> {
  const claude = findClaude();
  const claudeV = claude ? await version(claude, ['--version']) : null;
  const login = getSetting<{ ok: boolean; at: string; detail: string } | null>('claude_login', null);
  const ff = systemFfmpeg();
  const ffV = ff ? await version(ff, ['-version']) : null;
  const ffMajor = Number(ffV?.match(/version n?(\d+)/)?.[1] ?? 0);
  let py: string | null = null;
  for (const c of ['python3.12', 'python3.13', 'python3.11', 'python3']) {
    const v = await version(c, ['-c', 'import sys;print(sys.version.split()[0]) if sys.version_info>=(3,11) else exit(1)']);
    if (v) { py = `${c} ${v}`; break; }
  }
  const uv = which('uv');
  const pk = libPackages();
  const mock = getSetting('mock_mode', false);

  return [
    { id: 'node', label: 'Node.js 20+', needed: 'Everything', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.version },
    { id: 'claude', label: 'Claude Code CLI', needed: 'Research, script, video, review', ok: !!claude, detail: claude ? `${claudeV ?? '?'} — ${claude}` : 'not found',
      fix: 'npm install -g @anthropic-ai/claude-code' },
    { id: 'claude_login', label: 'Claude logged in (Pro)', needed: 'Research, script, video, review', ok: !!login?.ok,
      detail: login ? `${login.detail} (tested ${new Date(login.at).toLocaleString()})` : 'not tested yet — press “Test Claude”',
      fix: 'Run `claude` in Terminal and log in with your Claude Pro account, then press “Test Claude”.' },
    { id: 'ffmpeg', label: 'ffmpeg 7+', needed: 'Video production', ok: ffMajor >= 7, detail: ffV ? ffV.slice(0, 60) : 'not installed (a bundled copy is used for checks only)', fix: 'brew install ffmpeg' },
    { id: 'python', label: 'Python 3.11+ or uv', needed: 'Voice and music', ok: !!(py || uv), detail: py || (uv ? `uv ${uv}` : 'not found (system Python is too old)'), fix: 'brew install uv' },
    { id: 'skill', label: 'lemo-opuscar skill', needed: 'Video production', ok: fs.existsSync(path.join(SKILL_DIR, 'SKILL.md')), detail: SKILL_DIR },
    { id: 'library', label: 'Style library', needed: 'Video production', ok: fs.existsSync(path.join(LIB_DIR, 'AGENTS.md')), detail: LIB_DIR, fix: 'Press “Install video tools”.' },
    { id: 'packages', label: 'Video tool packages', needed: 'Video production', ok: pk.core && pk.voice && pk.music,
      detail: `core ${pk.core ? '✓' : '✗'} · voice ${pk.voice ? '✓' : '✗'} · music ${pk.music ? '✓' : '✗'}`, fix: 'Press “Install video tools” (needs ffmpeg and Python first).' },
    { id: 'youtube', label: 'YouTube app keys', needed: 'Publishing to YouTube', ok: PUBLISHERS.youtube.configured(), detail: PUBLISHERS.youtube.configured() ? 'set' : 'not set', fix: 'Settings → Connections → YouTube.' },
    { id: 'meta', label: 'Meta (Instagram) app keys', needed: 'Publishing to Instagram', ok: PUBLISHERS.instagram.configured(), detail: PUBLISHERS.instagram.configured() ? 'set' : 'not set', fix: 'Settings → Connections → Instagram.' },
    { id: 'cloudflared', label: 'Cloudflare tunnel tool', needed: 'Publishing to Instagram', ok: fs.existsSync(cloudflaredBin), detail: fs.existsSync(cloudflaredBin) ? 'installed' : 'downloads automatically on first Instagram post' },
    { id: 'mock', label: 'Test mode off', needed: 'Real videos', ok: !mock, detail: mock ? 'Test mode is on: stages write sample files and a test-pattern video without using Claude' : 'off' },
  ];
}

export async function testClaude() {
  const tmp = path.join(DATA_DIR, 'tmp'); fs.mkdirSync(tmp, { recursive: true });
  const r = await runClaude({ cwd: tmp, prompt: 'Reply with exactly: OK', tools: [], logPath: path.join(tmp, 'claude-test.jsonl'), model: 'haiku', timeoutMs: 90_000 });
  const res = { ok: r.ok, at: new Date().toISOString(), detail: r.ok ? 'working' : r.usageLimited ? 'logged in, but usage limit reached right now' : (r.error ?? 'failed') };
  if (r.usageLimited) res.ok = true;
  setSetting('claude_login', res);
  changed('health');
  return res;
}

// ─── Install the skill's packages (outside Claude, so it uses no quota) ───
let installing: { log: string[]; done: boolean; ok?: boolean } | null = null;
export const installState = () => installing;

export function installVideoTools() {
  if (installing && !installing.done) return installing;
  installing = { log: [], done: false };
  const state = installing;
  const push = (s: string) => { for (const l of s.split('\n')) if (l.trim()) state.log.push(l); if (state.log.length > 400) state.log.splice(0, state.log.length - 400); changed('install'); };
  const step = (args: string[]) => new Promise<number>((resolve) => {
    const p = spawn('sh', [path.join(SKILL_DIR, 'scripts/setup.sh'), ...args], { env: { ...process.env, PATH: toolPath() } });
    p.stdout.on('data', (d) => push(d.toString())); p.stderr.on('data', (d) => push(d.toString()));
    p.on('close', (c) => resolve(c ?? 1));
  });
  (async () => {
    push('→ Downloading/updating the style library'); let code = await step([]);
    if (code === 0) { push('→ Installing core, voice and music packages (several minutes the first time)'); code = await step(['deps', 'voice', 'music']); }
    state.done = true; state.ok = code === 0; push(code === 0 ? '✓ Video tools installed' : `✗ Install failed (exit ${code})`);
  })();
  return state;
}
