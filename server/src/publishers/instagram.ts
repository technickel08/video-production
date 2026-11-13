import { getSetting } from '../db.ts';
import { jsonFetch, redirectUri, tokensOf, saveTokens, upsertChannel, caption, type Channel, type PostCtx, type PublishResult, type Stats } from './common.ts';
import { shareFile } from './tunnel.ts';

const V = 'v21.0';
const GRAPH = () => `${process.env.GRAPH_BASE || 'https://graph.facebook.com'}/${V}`;
const DIALOG = () => `${process.env.FB_DIALOG_BASE || 'https://www.facebook.com'}/${V}/dialog/oauth`;
const SCOPES = ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement', 'business_management'];

interface Tokens { access_token: string; expires_at: number; }
const creds = () => ({ id: getSetting('meta_app_id', ''), secret: getSetting('meta_app_secret', '') });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Number(process.env.IG_POLL_MS || ms)));

export const configured = () => !!(creds().id && creds().secret);

export function authUrl(state: string) {
  const q = new URLSearchParams({ client_id: creds().id, redirect_uri: redirectUri('instagram'), state, scope: SCOPES.join(','), response_type: 'code' });
  return `${DIALOG()}?${q}`;
}

export async function handleCallback(code: string): Promise<number[]> {
  const short = await jsonFetch(`${GRAPH()}/oauth/access_token?${new URLSearchParams({ client_id: creds().id, client_secret: creds().secret, redirect_uri: redirectUri('instagram'), code })}`);
  const long = await jsonFetch(`${GRAPH()}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: creds().id, client_secret: creds().secret, fb_exchange_token: short.access_token })}`);
  const tokens: Tokens = { access_token: long.access_token, expires_at: Date.now() + (long.expires_in ?? 60 * 86400) * 1000 };
  const pages = await jsonFetch(`${GRAPH()}/me/accounts?${new URLSearchParams({ fields: 'name,instagram_business_account{id,username}', access_token: tokens.access_token })}`);
  const ids: number[] = [];
  for (const p of pages.data ?? []) {
    const ig = p.instagram_business_account;
    if (ig?.id) ids.push(upsertChannel('instagram', ig.id, `@${ig.username ?? ig.id}`, tokens));
  }
  if (!ids.length) throw new Error('No Instagram Business/Creator account is linked to your Facebook Pages');
  return ids;
}

/** Long-lived tokens last ~60 days; refresh them when less than 10 days remain. */
async function token(c: Channel) {
  const t = tokensOf<Tokens>(c);
  if (t.expires_at - Date.now() < 10 * 86400_000) {
    try {
      const r = await jsonFetch(`${GRAPH()}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: creds().id, client_secret: creds().secret, fb_exchange_token: t.access_token })}`);
      const next = { access_token: r.access_token, expires_at: Date.now() + (r.expires_in ?? 60 * 86400) * 1000 };
      saveTokens(c.id, next);
      return next.access_token;
    } catch {}
  }
  return t.access_token;
}

/** Reels flow: container with a public video URL → wait until processed → publish. */
export async function publish(ctx: PostCtx): Promise<PublishResult> {
  if (ctx.visibility !== 'public') throw new Error('Instagram can only post public Reels; set this video to Public to post it there.');
  const access_token = await token(ctx.channel);
  const ig = ctx.channel.external_id;
  const share = await shareFile(ctx.file);
  try {
    const container = await jsonFetch(`${GRAPH()}/${ig}/media`, {
      method: 'POST',
      body: new URLSearchParams({ media_type: 'REELS', video_url: share.url, caption: [ctx.meta.title, caption(ctx.meta)].join('\n\n').slice(0, 2200), share_to_feed: 'true', access_token }),
    });
    for (let i = 0; i < 90; i++) {
      await sleep(10_000);
      const s = await jsonFetch(`${GRAPH()}/${container.id}?${new URLSearchParams({ fields: 'status_code,status', access_token })}`);
      if (s.status_code === 'FINISHED') break;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram could not process the video: ${s.status ?? s.status_code}`);
      if (i === 89) throw new Error('Instagram took too long to process the video');
    }
    const pub = await jsonFetch(`${GRAPH()}/${ig}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: container.id, access_token }) });
    const info = await jsonFetch(`${GRAPH()}/${pub.id}?${new URLSearchParams({ fields: 'permalink', access_token })}`).catch(() => ({}));
    return { externalId: pub.id, url: info.permalink || `https://www.instagram.com/`, published: true };
  } finally {
    await share.close();
  }
}

export async function stats(c: Channel, ids: string[]): Promise<Record<string, Stats>> {
  const access_token = await token(c);
  const out: Record<string, Stats> = {};
  for (const id of ids) {
    try {
      const m = await jsonFetch(`${GRAPH()}/${id}?${new URLSearchParams({ fields: 'like_count,comments_count', access_token })}`);
      out[id] = { likes: m.like_count, comments: m.comments_count };
      const ins = await jsonFetch(`${GRAPH()}/${id}/insights?${new URLSearchParams({ metric: 'views', access_token })}`).catch(() => null);
      const views = ins?.data?.[0]?.values?.[0]?.value;
      if (views !== undefined) out[id].views = views;
    } catch {}
  }
  return out;
}
