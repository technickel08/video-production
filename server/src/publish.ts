import { all, get, run, now, getSetting, updateVideo } from './db.ts';
import { changed, notify } from './events.ts';
import { approve } from './pipeline.ts';
import { loadPostCtx, type Channel, type PostCtx, type PublishResult, type Stats } from './publishers/common.ts';
import * as youtube from './publishers/youtube.ts';
import * as instagram from './publishers/instagram.ts';

interface Publisher {
  configured: () => boolean;
  authUrl: (state: string) => string;
  handleCallback: (code: string) => Promise<number[]>;
  publish: (ctx: PostCtx) => Promise<PublishResult>;
  stats: (c: Channel, ids: string[]) => Promise<Record<string, Stats>>;
  /** Upload ahead of time (platform schedules it) vs. post exactly at the scheduled time. */
  uploadsAhead: boolean;
}
export const PUBLISHERS: Record<string, Publisher> = {
  youtube: { ...youtube, uploadsAhead: true },
  instagram: { ...instagram, uploadsAhead: false },
};

let publishing = false;

/**
 * Self-repair: a "scheduled" video whose posts are gone (e.g. its channel was disconnected) gets posts for the
 * project's current channels, or goes back to "ready to publish" when the project has none.
 */
export function repairOrphans() {
  const orphans = all<{ id: number; project_id: number }>(`SELECT v.id, v.project_id FROM videos v
    WHERE v.stage='publish' AND v.status='scheduled' AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.video_id=v.id)`);
  for (const v of orphans) {
    try { approve(v.id); } catch (e: any) { console.error(`[repair ${v.id}]`, e.message); }
    changed('video', v.id);
  }
}

/** Publish an approved video now: posts not yet uploaded are moved to now and sent right away. */
export async function publishNow(videoId: number) {
  const posts = all<{ id: number; status: string; platform: string }>('SELECT id, status, platform FROM posts WHERE video_id=?', videoId);
  if (!posts.length) {
    approve(videoId, now());
  } else {
    const waiting = posts.filter((p) => ['pending', 'failed'].includes(p.status));
    if (!waiting.length) throw new Error('This video is already uploaded everywhere. For YouTube, make it public in YouTube Studio.');
    run(`UPDATE posts SET status='pending', scheduled_at=?, error=NULL WHERE video_id=? AND status IN ('pending','failed')`, now(), videoId);
    if (!posts.some((p) => ['scheduled', 'uploading', 'published'].includes(p.status))) run('UPDATE videos SET scheduled_at=? WHERE id=?', now(), videoId);
    updateVideo(videoId, { status: 'scheduled', error: null });
  }
  changed('video', videoId);
  void publishTick();
}

/** Post anything that is due, then roll post states up to their videos. */
export async function publishTick() {
  if (publishing || getSetting('paused', false)) return;
  publishing = true;
  try {
    repairOrphans();
    const due = all<{ id: number; platform: string; scheduled_at: string; video_id: number; visibility: string }>(
      `SELECT p.*, v.visibility FROM posts p JOIN videos v ON v.id=p.video_id WHERE p.status='pending' ORDER BY p.scheduled_at`);
    for (const p of due) {
      const pub = PUBLISHERS[p.platform];
      if (!pub) continue;
      // Only public YouTube videos can be uploaded ahead (YouTube flips them public at publishAt);
      // private/unlisted uploads and Instagram posts happen at the scheduled time.
      const ahead = pub.uploadsAhead && p.visibility === 'public';
      if (!ahead && p.scheduled_at > now()) continue;
      run(`UPDATE posts SET status='uploading', error=NULL WHERE id=?`, p.id);
      changed('video', p.video_id);
      try {
        const res = await pub.publish(loadPostCtx(p.id));
        run(`UPDATE posts SET status=?, external_id=?, url=?, published_at=? WHERE id=?`,
          res.published ? 'published' : 'scheduled', res.externalId, res.url, res.published ? now() : null, p.id);
      } catch (e: any) {
        run(`UPDATE posts SET status='failed', error=? WHERE id=?`, String(e?.message || e).slice(0, 1000), p.id);
        notify(`${p.platform} post failed`, String(e?.message || e).slice(0, 120));
      }
      changed('video', p.video_id);
    }
    // Platform-scheduled posts (YouTube publishAt) count as published once their time passes.
    run(`UPDATE posts SET status='published', published_at=scheduled_at WHERE status='scheduled' AND scheduled_at<=?`, now());
    rollUp();
  } finally { publishing = false; }
}

function rollUp() {
  const vids = all<{ id: number; title: string }>(`SELECT id, title FROM videos WHERE stage='publish' AND status IN ('scheduled','failed')`);
  for (const v of vids) {
    const posts = all<{ status: string; error: string | null; platform: string }>('SELECT status, error, platform FROM posts WHERE video_id=?', v.id);
    if (!posts.length) continue;
    const failed = posts.filter((p) => p.status === 'failed');
    if (posts.every((p) => p.status === 'published')) {
      updateVideo(v.id, { stage: 'done', status: 'published', error: null });
      notify('Published', v.title);
      changed('video', v.id);
    } else if (failed.length && posts.every((p) => ['failed', 'published', 'scheduled'].includes(p.status))) {
      const err = failed.map((p) => `${p.platform}: ${p.error}`).join('\n');
      const cur = get<{ status: string; error: string | null }>('SELECT status, error FROM videos WHERE id=?', v.id)!;
      if (cur.status !== 'failed' || cur.error !== err) { updateVideo(v.id, { status: 'failed', error: err }); changed('video', v.id); }
    }
  }
}

let lastStats = 0;
export async function statsTick(force = false) {
  if (!force && Date.now() - lastStats < 6 * 3600_000) return;
  lastStats = Date.now();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const rows = all<{ id: number; channel_id: number; platform: string; external_id: string }>(
    `SELECT id, channel_id, platform, external_id FROM posts WHERE status='published' AND external_id IS NOT NULL AND published_at>=?`, since);
  const byChannel = new Map<number, typeof rows>();
  for (const r of rows) byChannel.set(r.channel_id, [...(byChannel.get(r.channel_id) || []), r]);
  const date = new Date().toISOString().slice(0, 10);
  for (const [cid, posts] of byChannel) {
    const channel = get<Channel>('SELECT * FROM channels WHERE id=?', cid);
    if (!channel) continue;
    try {
      const s = await PUBLISHERS[channel.platform].stats(channel, posts.map((p) => p.external_id));
      for (const p of posts) {
        const x = s[p.external_id]; if (!x) continue;
        run(`INSERT INTO stats(post_id,date,views,likes,comments) VALUES (?,?,?,?,?)
          ON CONFLICT(post_id,date) DO UPDATE SET views=excluded.views, likes=excluded.likes, comments=excluded.comments`,
          p.id, date, x.views ?? null, x.likes ?? null, x.comments ?? null);
      }
    } catch (e: any) { console.warn(`stats for channel ${cid} failed:`, e?.message); }
  }
  changed('stats');
}
