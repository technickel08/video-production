import fs from 'node:fs';
import { all, run } from './db.ts';

export interface Usage { cost_usd: number; turns: number; tokens_new: number; tokens_cached: number; tokens_out: number; model: string }

/** Add up what the Claude runs in one step's log used. A step can hold several runs (script + hook check). */
export function usageOf(logPath: string): Usage | null {
  let text: string;
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return null; }
  const u: Usage = { cost_usd: 0, turns: 0, tokens_new: 0, tokens_cached: 0, tokens_out: 0, model: '' };
  const byModel: Record<string, number> = {};
  let found = false;
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"result"')) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'result') continue;
    found = true;
    u.cost_usd += e.total_cost_usd ?? 0; u.turns += e.num_turns ?? 0;
    u.tokens_new += (e.usage?.input_tokens ?? 0) + (e.usage?.cache_creation_input_tokens ?? 0);
    u.tokens_cached += e.usage?.cache_read_input_tokens ?? 0; u.tokens_out += e.usage?.output_tokens ?? 0;
    for (const [m, x] of Object.entries<any>(e.modelUsage ?? {})) byModel[m] = (byModel[m] ?? 0) + (x?.costUSD ?? 0);
  }
  if (!found) return null;
  u.model = (Object.entries(byModel).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '').replace(/^claude-/, '').replace(/\[.*$/, '');
  u.cost_usd = Math.round(u.cost_usd * 1000) / 1000;
  return u;
}

export function recordUsage(runId: number, logPath: string) {
  const u = usageOf(logPath);
  if (!u) return;
  run('UPDATE stage_runs SET cost_usd=?, turns=?, tokens_new=?, tokens_cached=?, tokens_out=?, model=? WHERE id=?', u.cost_usd, u.turns, u.tokens_new, u.tokens_cached, u.tokens_out, u.model, runId);
}

/** Fill in usage for runs recorded before this was tracked. */
export function backfillUsage() {
  for (const r of all<{ id: number; log_path: string }>(`SELECT id, log_path FROM stage_runs WHERE cost_usd IS NULL AND log_path IS NOT NULL AND status<>'running'`)) recordUsage(r.id, r.log_path);
}
