import fs from 'node:fs';
import { getSetting } from '../db.ts';
import { jsonFetch, redirectUri, saveTokens, tokensOf, upsertChannel, caption, type Channel, type PostCtx, type PublishResult, type Stats } from './common.ts';

const OAUTH = () => process.env.YT_OAUTH_BASE || 'https://oauth2.googleapis.com';
const AUTH = () => process.env.YT_AUTH_BASE || 'https://accounts.google.com';
const API = () => process.env.YT_API_BASE || 'https://www.googleapis.com';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

interface Tokens { access_token: string; refresh_token: string; expires_at: number; }
const creds = () => ({ id: getSetting('youtube_client_id', ''), secret: getSetting('youtube_client_secret', '') });

export const configured = () => !!(creds().id && creds().secret);

export function authUrl(state: string) {
  const q = new URLSearchParams({
    client_id: creds().id, redirect_uri: redirectUri('youtube'), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `${AUTH()}/o/oauth2/v2/auth?${q}`;
}

export async function handleCallback(code: string): Promise<number[]> {
  const t = await jsonFetch(`${OAUTH()}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: creds().id, client_secret: creds().secret, redirect_uri: redirectUri('youtube'), grant_type: 'authorization_code' }),
  });
  const granted = String(t.scope || '');
  if (!granted.includes('youtube.upload')) throw new Error('Upload permission was not granted. Press Connect again and tick every permission box on Google’s consent screen.');
  if (!t.refresh_token) throw new Error('Google did not return a long-lived sign-in. Remove the app at myaccount.google.com/connections, then press Connect again.');
  const tokens: Tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
  const ch = await jsonFetch(`${API()}/youtube/v3/channels?part=snippet&mine=true`, { headers: { authorization: `Bearer ${tokens.access_token}` } })
    .catch((e) => { throw new Error(`Could not read your YouTube channel (${e.message}). Make sure “YouTube Data API v3” is enabled in your Google Cloud project.`); });
  if (!ch.items?.length) throw new Error('The Google account you picked has no YouTube channel. If your channel is a Brand Account, press Connect again and pick the channel (not your personal account) on Google’s account chooser.');
  return ch.items.map((c: any) => upsertChannel('youtube', c.id, c.snippet.title, tokens));
}

async function accessToken(c: Channel): Promise<string> {
  const t = tokensOf<Tokens>(c);
  if (t.expires_at > Date.now() + 60_000) return t.access_token;
  const r = await jsonFetch(`${OAUTH()}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: creds().id, client_secret: creds().secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  });
  const next = { ...t, access_token: r.access_token, expires_at: Date.now() + r.expires_in * 1000 };
  saveTokens(c.id, next);
  return next.access_token;
}

/** Resumable upload. Future posts are uploaded private with publishAt so YouTube publishes them on time. */
export async function publish(ctx: PostCtx): Promise<PublishResult> {
  const token = await accessToken(ctx.channel);
  const when = new Date(ctx.post.scheduled_at);
  // Only public videos are scheduled through publishAt; private/unlisted are uploaded as they are.
  const future = ctx.visibility === 'public' && when.getTime() > Date.now() + 15 * 60_000;
  const tags = ctx.meta.hashtags.map((h) => h.replace(/^#/, '')).slice(0, 15);
  const body = {
    snippet: { title: ctx.meta.title.slice(0, 100), description: caption(ctx.meta).slice(0, 4900), tags, categoryId: getSetting('youtube_category', '27') },
    status: {
      privacyStatus: future ? 'private' : ctx.visibility, ...(future ? { publishAt: when.toISOString() } : {}),
      selfDeclaredMadeForKids: false, containsSyntheticMedia: true,
    },
  };
  const size = fs.statSync(ctx.file).size;
  const init = await fetch(`${API()}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(size), 'x-upload-content-type': 'video/mp4' },
    body: JSON.stringify(body),
  });
  if (!init.ok) throw new Error(`YouTube upload start failed: ${init.status} ${(await init.text()).slice(0, 300)}`);
  const location = init.headers.get('location');
  if (!location) throw new Error('YouTube did not return an upload URL');

  const put = await fetch(location, {
    method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
    body: fs.createReadStream(ctx.file) as any, duplex: 'half',
  } as RequestInit);
  const res = await put.json().catch(() => ({}));
  if (!put.ok || !res.id) throw new Error(`YouTube upload failed: ${put.status} ${JSON.stringify(res).slice(0, 300)}`);

  if (ctx.posterFile) {
    await fetch(`${API()}/upload/youtube/v3/thumbnails/set?videoId=${res.id}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }, body: fs.readFileSync(ctx.posterFile),
    }).catch(() => {}); // custom thumbnails need a verified channel; ignore failures
  }
  return { externalId: res.id, url: `https://youtube.com/shorts/${res.id}`, published: !future };
}

export async function stats(c: Channel, ids: string[]): Promise<Record<string, Stats>> {
  if (!ids.length) return {};
  const token = await accessToken(c);
  const r = await jsonFetch(`${API()}/youtube/v3/videos?part=statistics&id=${ids.join(',')}`, { headers: { authorization: `Bearer ${token}` } });
  const out: Record<string, Stats> = {};
  for (const i of r.items ?? []) out[i.id] = { views: Number(i.statistics.viewCount ?? 0), likes: Number(i.statistics.likeCount ?? 0), comments: Number(i.statistics.commentCount ?? 0) };
  return out;
}
