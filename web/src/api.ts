export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    ...rest,
    headers: json !== undefined ? { 'content-type': 'application/json', ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/') && window.location.pathname !== '/login') { window.location.assign('/login'); return new Promise<T>(() => {}); }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body as T;
}

export const post = <T = any>(path: string, json: unknown = {}) => api<T>(path, { method: 'POST', json });
export const put = <T = any>(path: string, json: unknown) => api<T>(path, { method: 'PUT', json });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export type Visibility = 'public' | 'unlisted' | 'private';
export const VISIBILITY: { id: Visibility; label: string; hint: string }[] = [
  { id: 'public', label: 'Public', hint: 'Everyone can find and watch it' },
  { id: 'unlisted', label: 'Unlisted', hint: 'Only people with the link (YouTube only)' },
  { id: 'private', label: 'Private', hint: 'Only you, in YouTube Studio (YouTube only)' },
];

export type Stage = 'research' | 'script' | 'production' | 'produce' | 'check' | 'approval' | 'publish' | 'done';
export type Status = 'queued' | 'running' | 'waiting_usage' | 'failed' | 'awaiting_review' | 'awaiting_approval' | 'scheduled' | 'ready_to_publish' | 'published' | 'rejected' | 'archived';

export interface Project {
  id: number; name: string; niche: string; audience: string; language: string; format: string; duration_sec: number;
  aspect_ratio: string; styles: string[]; voice: boolean; music: boolean; captions: boolean; notes: string;
  post_times: string[]; post_days: number[]; daily_cap: number; autopilot: boolean; auto_publish: boolean; active: boolean;
  channel_ids: number[]; counts?: Record<string, number>; next_slot?: string; created_at: string; visibility: Visibility;
  voice_name: string; voice_speed: number; voice_style: string; music_mood: string; production_step: boolean; review_steps: boolean;
}
export interface Video {
  id: number; project_id: number; project_name?: string; title: string; topic: string; stage: Stage; status: Status;
  error: string | null; note: string | null; scheduled_at: string | null; created_at: string; updated_at: string;
  has_poster?: boolean; aspect_ratio?: string; retry_at: string | null; produce_attempts: number; visibility: Visibility; production_step?: number | boolean;
}
export interface Run { id: number; stage: Stage; status: string; started_at: string; finished_at: string | null; error: string | null;
  cost_usd: number | null; turns: number | null; tokens_new: number | null; tokens_cached: number | null; tokens_out: number | null; model: string | null; }
export interface Artifact { path: string; stage: Stage; kind: 'video' | 'image' | 'audio' | 'markdown' | 'json' | 'text'; size: number; mtime: string; }
export interface Post { id: number; platform: string; status: string; scheduled_at: string; url: string | null; error: string | null; channel_name: string; }
export interface VideoDetail extends Video {
  project: Project; meta: { title?: string; description?: string; hashtags?: string[]; style?: string } | null;
  hook: { hook_score: number; title_score: number; hook_line?: string; pass: boolean; issues?: string[]; better_hooks?: string[]; better_titles?: string[] } | null;
  runs: Run[]; artifacts: Artifact[]; posts: Post[]; stats: { date: string; views: number; likes: number; comments: number; platform: string }[]; running: boolean;
}
export interface Channel { id: number; platform: 'youtube' | 'instagram'; name: string; status: string; projects: number[]; created_at: string; }
export interface Voice { id: string; name: string; gender: 'Female' | 'Male'; accent: string; lang: string; hint?: string; }
export interface Insight { id: number; title: string; hook: string; style: string; views: number; likes: number; comments: number; hook_score: number | null; }
export interface Style { slug: string; name: string; category: string; }

export const STAGE_LABEL: Record<Stage, string> = {
  research: 'Research', script: 'Script', production: 'Production', produce: 'Video', check: 'Check', approval: 'Approval', publish: 'Publish', done: 'Done',
};
export const STATUS_LABEL: Record<Status, string> = {
  queued: 'Queued', running: 'Working', waiting_usage: 'Waiting for Claude', failed: 'Failed', awaiting_review: 'Needs review', awaiting_approval: 'Needs approval',
  scheduled: 'Scheduled', ready_to_publish: 'Ready — no channel', published: 'Published', rejected: 'Rejected', archived: 'Archived',
};

/** The steps a video goes through; Production is left out when the project has it off. */
export const stepsFor = (production: unknown): Stage[] =>
  (['research', 'script', 'production', 'produce', 'check', 'approval', 'publish'] as Stage[]).filter((s) => s !== 'production' || production !== false && production !== 0);
export const REVIEW_STAGES: Stage[] = ['research', 'script', 'production'];

export const fileUrl = (videoId: number, path: string, bust?: string) => `/files/${videoId}/${path.split('/').map(encodeURIComponent).join('/')}${bust ? `?v=${encodeURIComponent(bust)}` : ''}`;

/** Claude's own estimate of what a run would cost on the API. Not billed on a subscription; useful for comparing steps. */
export const usageLabel = (cost: number) => cost >= 0.995 ? `$${cost.toFixed(2)}` : `${Math.round(cost * 100)}¢`;
export const USAGE_HINT = 'Estimated usage, shown as what it would cost on the API. You are not billed this on your plan — it is for comparing steps and videos.';

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }) {
  return iso ? new Date(iso).toLocaleString(undefined, opts) : '—';
}
export function ago(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export function duration(from: string, to?: string | null) {
  const s = Math.max(0, Math.round(((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
/** ISO → value for <input type="datetime-local"> in local time. */
export function toLocalInput(iso: string) {
  const d = new Date(iso); const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
