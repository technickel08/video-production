import fs from 'node:fs';
import path from 'node:path';
import { get, run, getSetting } from '../db.ts';
import { encrypt, decrypt } from '../secrets.ts';
import { videoDir, BASE_URL } from '../paths.ts';

export interface Channel { id: number; platform: string; name: string; external_id: string; tokens: string; status: string; }
export interface PostCtx {
  post: { id: number; video_id: number; channel_id: number; scheduled_at: string };
  channel: Channel;
  file: string;
  meta: { title: string; description: string; hashtags: string[] };
  posterFile: string | null;
  visibility: 'public' | 'unlisted' | 'private';
}
export interface PublishResult { externalId: string; url: string; published: boolean; }
export interface Stats {
  views?: number; likes?: number; comments?: number; shares?: number; saves?: number; reach?: number; subs_gained?: number;
  /** Share of the video watched on average (0–100) and average seconds watched. */
  avg_view_pct?: number; avg_view_sec?: number;
}
/** Slower, per-video detail fetched only at checkpoints. */
export interface Deep { retention?: number[]; comments?: string[] }

export const tokensOf = <T>(c: Channel) => decrypt<T>(c.tokens);
export const saveTokens = (channelId: number, tokens: unknown) => run('UPDATE channels SET tokens=? WHERE id=?', encrypt(tokens), channelId);

export function upsertChannel(platform: string, externalId: string, name: string, tokens: unknown): number {
  const existing = get<{ id: number }>('SELECT id FROM channels WHERE platform=? AND external_id=?', platform, externalId);
  if (existing) {
    run(`UPDATE channels SET name=?, tokens=?, status='connected' WHERE id=?`, name, encrypt(tokens), existing.id);
    return existing.id;
  }
  const r = run(`INSERT INTO channels(platform, external_id, name, tokens, status, created_at) VALUES (?,?,?,?, 'connected', ?)`,
    platform, externalId, name, encrypt(tokens), new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function loadPostCtx(postId: number): PostCtx {
  const post = get<any>('SELECT * FROM posts WHERE id=?', postId)!;
  const channel = get<Channel>('SELECT * FROM channels WHERE id=?', post.channel_id)!;
  const video = get<any>('SELECT * FROM videos WHERE id=?', post.video_id)!;
  const dir = videoDir(video.project_id, video.id);
  let meta: any = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')); } catch {}
  const poster = path.join(dir, 'poster.jpg');
  return {
    post, channel, file: path.join(dir, 'final.mp4'), posterFile: fs.existsSync(poster) ? poster : null, visibility: video.visibility || 'public',
    meta: { title: meta.title || video.title || 'Untitled', description: meta.description || '', hashtags: meta.hashtags || [] },
  };
}

export const redirectUri = (platform: string) => `${getSetting('oauth_base_url', BASE_URL)}/api/oauth/${platform}/callback`;

export async function jsonFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error_description || body?.error || text;
    if (msg === 'API access blocked.') throw new Error('Meta has blocked API access for your Meta app (this is on Meta’s side, not this app). Open developers.facebook.com → your app and facebook.com/accountquality to see the restriction and request a review.');
    throw new Error(`${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`.slice(0, 500));
  }
  return body;
}

export const caption = (m: PostCtx['meta']) => [m.description, m.hashtags.join(' ')].filter(Boolean).join('\n\n');
