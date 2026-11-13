import fs from 'node:fs';
import path from 'node:path';
import { all } from './db.ts';
import { videoDir } from './paths.ts';

export interface Performance { id: number; title: string; topic: string; hook: string; style: string; views: number; likes: number; comments: number; published_at: string; hook_score: number | null }

const MIN_VIDEOS = 5;          // below this, numbers are noise
const MIN_AGE_HOURS = 24;      // a video needs a day before its views mean anything

/** Published videos of a project with their latest numbers summed across platforms, best first. */
export function performance(projectId: number): Performance[] {
  const cutoff = new Date(Date.now() - MIN_AGE_HOURS * 3600_000).toISOString();
  const rows = all<any>(`
    SELECT v.id, v.title, v.topic, MIN(p.published_at) published_at,
      SUM(COALESCE((SELECT s.views FROM stats s WHERE s.post_id=p.id ORDER BY s.date DESC LIMIT 1),0)) views,
      SUM(COALESCE((SELECT s.likes FROM stats s WHERE s.post_id=p.id ORDER BY s.date DESC LIMIT 1),0)) likes,
      SUM(COALESCE((SELECT s.comments FROM stats s WHERE s.post_id=p.id ORDER BY s.date DESC LIMIT 1),0)) comments
    FROM videos v JOIN posts p ON p.video_id=v.id
    WHERE v.project_id=? AND p.status='published' AND p.published_at<=?
      AND EXISTS (SELECT 1 FROM stats s WHERE s.post_id=p.id)
    GROUP BY v.id ORDER BY views DESC, likes DESC`, projectId, cutoff);
  return rows.map((r) => {
    const dir = videoDir(projectId, r.id);
    const read = (f: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
    const meta = read('metadata.json'); const hook = read('hook.json');
    return { ...r, hook: meta?.hook || hook?.hook_line || '', style: meta?.style || '', hook_score: hook?.hook_score ?? null };
  });
}

/** What the research and script steps are told about past results. Empty until there is enough data. */
export function performanceText(projectId: number): string {
  const list = performance(projectId);
  if (list.length < MIN_VIDEOS) return '';
  const n = Math.min(3, Math.floor(list.length / 2));
  const line = (v: Performance) => `- "${v.title}" — ${v.views} views, ${v.likes} likes, ${v.comments} comments${v.style ? ` · style ${v.style}` : ''}${v.hook ? ` · hook: "${v.hook}"` : ''}`;
  return [
    `## What has worked on this channel (${list.length} published videos)`,
    'Best performers:', ...list.slice(0, n).map(line),
    'Weakest performers:', ...list.slice(-n).map(line),
    'Work out what the best ones share (subject, angle, kind of hook, title shape, style) and lean towards it; avoid what the weakest share. Do not repeat a topic, and do not mention these numbers in the video.',
    '',
  ].join('\n');
}
