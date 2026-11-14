import fs from 'node:fs';
import path from 'node:path';
import { all, run, now } from './db.ts';
import { runClaude, describeEvent, type ClaudeResult } from './claude.ts';
import { getSetting } from './db.ts';
import { setUsageWait } from './pipeline.ts';
import { usageOf } from './usage.ts';
import { changed } from './events.ts';

/** A background Claude run that is not part of a video: the analyst or the skill scout. */
export interface JobRun { id: number; logPath: string }

export function startJob(kind: string, projectId: number | null, dir: string): JobRun {
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const logPath = path.join(dir, 'logs', `${kind}-${Date.now()}.jsonl`);
  const r = run('INSERT INTO jobs(kind, project_id, status, started_at, log_path) VALUES (?,?,?,?,?)', kind, projectId, 'running', now(), logPath);
  changed('jobs');
  return { id: Number(r.lastInsertRowid), logPath };
}

export function finishJob(job: JobRun, status: 'done' | 'failed', error?: string) {
  const u = usageOf(job.logPath);
  run('UPDATE jobs SET status=?, finished_at=?, error=?, cost_usd=? WHERE id=?', status, now(), error ?? null, u?.cost_usd ?? null, job.id);
  changed('jobs');
}

/** Run Claude for a job. A usage-limit hit pauses every Claude run until the reset, as for videos. */
export async function jobClaude(job: JobRun, o: { cwd: string; prompt: string; tools: string[]; timeoutMs: number; model?: string; addDirs?: string[] }): Promise<ClaudeResult> {
  const r = await runClaude({ ...o, logPath: job.logPath, model: o.model || undefined, onEvent: (e) => { const t = describeEvent(e); if (t) changed('job-log', job.id, { line: t }); } });
  if (r.usageLimited && r.retryAt) setUsageWait(r.retryAt);
  return r;
}

export const recentJobs = (kind?: string, projectId?: number, limit = 10) =>
  all(`SELECT * FROM jobs WHERE (? IS NULL OR kind=?) AND (? IS NULL OR project_id=?) ORDER BY id DESC LIMIT ?`,
    kind ?? null, kind ?? null, projectId ?? null, projectId ?? null, limit);

export const modelFor = (kind: string, fallback = '') => getSetting<string>(`model_${kind}`, '') || fallback;
