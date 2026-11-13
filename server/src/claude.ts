import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSetting } from './db.ts';
import { toolPath } from './tools.ts';

/** Find the Claude Code CLI: a setting, then PATH, then the copy bundled with Claude Desktop. */
export function findClaude(): string | null {
  const custom = getSetting<string>('claude_path', '');
  if (custom && fs.existsSync(custom)) return custom;
  try {
    const p = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim();
    if (p) return p;
  } catch {}
  for (const p of [path.join(os.homedir(), '.claude/local/claude'), path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  const base = path.join(os.homedir(), 'Library/Application Support/Claude/claude-code');
  try {
    const versions = fs.readdirSync(base).filter((v) => /^\d/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      for (const h of fs.readdirSync(path.join(base, v))) {
        const bin = path.join(base, v, h, 'claude.app/Contents/MacOS/claude');
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {}
  return null;
}

export interface ClaudeRun {
  cwd: string;
  prompt: string;
  tools: string[];
  logPath: string;
  model?: string;
  addDirs?: string[];
  timeoutMs?: number;
  onEvent?: (e: any) => void;
}
export interface ClaudeResult {
  ok: boolean;
  text: string;
  usageLimited: boolean;
  retryAt?: string;
  error?: string;
  notLoggedIn?: boolean;
}

let current: ChildProcess | null = null;
export const cancelCurrent = () => { current?.kill('SIGTERM'); };

export function runClaude(o: ClaudeRun): Promise<ClaudeResult> {
  const bin = findClaude();
  if (!bin) return Promise.resolve({ ok: false, text: '', usageLimited: false, error: 'Claude Code CLI not found. Install it and log in (see Settings → Health).' });

  const args = ['-p', o.prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits', '--allowedTools', o.tools.join(',')];
  const model = o.model || getSetting<string>('claude_model', '');
  if (model) args.push('--model', model);
  for (const d of o.addDirs || []) args.push('--add-dir', d);

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: toolPath() };
  // Use the logged-in subscription, never an API key, and don't look like a nested session.
  delete env.ANTHROPIC_API_KEY; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CLAUDE_CODE_SSE_PORT;

  fs.mkdirSync(path.dirname(o.logPath), { recursive: true });
  const log = fs.createWriteStream(o.logPath, { flags: 'a' });

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    let buf = '', stderr = '', final: any = null;
    const timer = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs ?? 30 * 60_000);

    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        log.write(line + '\n');
        try {
          const e = JSON.parse(line);
          if (e.type === 'result') final = e;
          o.onEvent?.(e);
        } catch {}
      }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); log.write(JSON.stringify({ type: 'stderr', text: d.toString() }) + '\n'); });
    child.on('error', (err) => { clearTimeout(timer); current = null; log.end(); resolve({ ok: false, text: '', usageLimited: false, error: err.message }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); current = null; log.end();
      const text: string = final?.result ?? '';
      const all = `${text}\n${stderr}`;
      const usageLimited = /usage limit|limit reached|hit your limit|rate.?limit|out of (extra )?usage|resets? (at|in)/i.test(all) && (!final || final.is_error);
      if (usageLimited) return resolve({ ok: false, text, usageLimited, retryAt: parseReset(all), error: firstLine(text || stderr) });
      if (/not logged in|please run \/login|invalid api key|oauth token/i.test(all)) {
        return resolve({ ok: false, text, usageLimited: false, notLoggedIn: true, error: 'Claude Code is not logged in. Run `claude` in a terminal and log in with your Pro account.' });
      }
      if (signal) return resolve({ ok: false, text, usageLimited: false, error: `Stopped (${signal === 'SIGTERM' ? 'cancelled or timed out' : signal})` });
      if (!final || final.is_error || code !== 0) return resolve({ ok: false, text, usageLimited: false, error: firstLine(text || stderr) || `Claude exited with code ${code}` });
      resolve({ ok: true, text, usageLimited: false });
    });
  });
}

const firstLine = (s: string) => s.trim().split('\n')[0]?.slice(0, 400) ?? '';

/** Work out when a usage limit resets; default to 30 minutes from now. */
export function parseReset(s: string, from = new Date()): string {
  const epoch = s.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000 + 60_000).toISOString();
  const m = s.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (m) {
    let h = Number(m[1]) % 12; if (m[3].toLowerCase() === 'pm') h += 12;
    const d = new Date(from); d.setHours(h, Number(m[2] || 0) + 1, 0, 0);
    if (d <= from) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const rel = s.match(/resets?\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (rel && (rel[1] || rel[2])) return new Date(from.getTime() + ((Number(rel[1] || 0) * 60 + Number(rel[2] || 0) + 1) * 60_000)).toISOString();
  return new Date(from.getTime() + 30 * 60_000).toISOString();
}

/** Short human text for a stream-json event, for live logs. */
export function describeEvent(e: any): string | null {
  if (e.type === 'assistant') {
    const parts: string[] = [];
    for (const c of e.message?.content ?? []) {
      if (c.type === 'text' && c.text.trim()) parts.push(c.text.trim());
      if (c.type === 'tool_use') {
        const i = c.input || {};
        const arg = i.command || i.file_path || i.query || i.url || i.pattern || i.description || '';
        parts.push(`▸ ${c.name}${arg ? `: ${String(arg).slice(0, 160)}` : ''}`);
      }
    }
    return parts.join('\n') || null;
  }
  if (e.type === 'result') return e.is_error ? `✗ ${e.result}` : '✓ Step finished';
  if (e.type === 'stderr') return e.text;
  return null;
}
