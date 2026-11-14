import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './paths.ts';

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  niche TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'English',
  format TEXT NOT NULL DEFAULT 'Short',
  duration_sec INTEGER NOT NULL DEFAULT 45,
  aspect_ratio TEXT NOT NULL DEFAULT '9:16',
  styles TEXT NOT NULL DEFAULT '[]',
  voice INTEGER NOT NULL DEFAULT 1,
  music INTEGER NOT NULL DEFAULT 1,
  captions INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  post_times TEXT NOT NULL DEFAULT '["18:00"]',
  post_days TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  daily_cap INTEGER NOT NULL DEFAULT 1,
  autopilot INTEGER NOT NULL DEFAULT 0,
  auto_publish INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'research',
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  note TEXT,
  produce_attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stage_runs (
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  log_path TEXT
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  external_id TEXT NOT NULL,
  tokens TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  created_at TEXT NOT NULL,
  UNIQUE(platform, external_id)
);
CREATE TABLE IF NOT EXISTS project_channels (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, channel_id)
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  error TEXT,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS stats (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  views INTEGER, likes INTEGER, comments INTEGER,
  PRIMARY KEY (post_id, date)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metrics (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  checkpoint TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (post_id, checkpoint)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  link TEXT, ref TEXT, created_at TEXT NOT NULL, read_at TEXT
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  level TEXT NOT NULL, title TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'low', changes TEXT NOT NULL, before TEXT,
  status TEXT NOT NULL, auto INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL,
  repo TEXT NOT NULL, subpath TEXT NOT NULL DEFAULT '', ref TEXT, card TEXT NOT NULL,
  status TEXT NOT NULL, path TEXT, found_at TEXT NOT NULL, installed_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, project_id INTEGER, status TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, error TEXT, log_path TEXT, cost_usd REAL
);
`);

// Additive migrations for databases created by earlier versions.
function addColumn(table: string, column: string, def: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('projects', 'visibility', `TEXT NOT NULL DEFAULT 'public'`);
addColumn('videos', 'visibility', `TEXT NOT NULL DEFAULT 'public'`);
addColumn('projects', 'voice_name', `TEXT NOT NULL DEFAULT ''`);
addColumn('projects', 'voice_speed', `REAL NOT NULL DEFAULT 0`);
addColumn('projects', 'voice_style', `TEXT NOT NULL DEFAULT ''`);
addColumn('projects', 'music_mood', `TEXT NOT NULL DEFAULT ''`);
addColumn('videos', 'archived_from', `TEXT`);
for (const [c, t] of [['cost_usd', 'REAL'], ['turns', 'INTEGER'], ['tokens_new', 'INTEGER'], ['tokens_cached', 'INTEGER'], ['tokens_out', 'INTEGER'], ['model', 'TEXT']]) addColumn('stage_runs', c, t);
addColumn('projects', 'production_step', `INTEGER NOT NULL DEFAULT 1`);
addColumn('projects', 'review_steps', `INTEGER NOT NULL DEFAULT 1`);
addColumn('projects', 'adapt_mode', `TEXT NOT NULL DEFAULT 'ask'`);
addColumn('projects', 'focus', `TEXT NOT NULL DEFAULT ''`);
addColumn('projects', 'analyzed_at', `TEXT`);
addColumn('projects', 'next_style', `TEXT`);
addColumn('projects', 'extra_skills', `TEXT NOT NULL DEFAULT '[]'`);

export const VISIBILITIES = ['public', 'unlisted', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

type Row = Record<string, any>;
export const all = <T = Row>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as T[];
export const get = <T = Row>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as T | undefined;
export const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);
export const now = () => new Date().toISOString();

export interface Project {
  id: number; name: string; niche: string; audience: string; language: string; format: string;
  duration_sec: number; aspect_ratio: string; styles: string[]; voice: boolean; music: boolean; captions: boolean;
  notes: string; post_times: string[]; post_days: number[]; daily_cap: number; autopilot: boolean;
  auto_publish: boolean; active: boolean; created_at: string; channel_ids: number[]; visibility: Visibility;
  voice_name: string; voice_speed: number; voice_style: string; music_mood: string;
  production_step: boolean; review_steps: boolean;
  adapt_mode: 'ask' | 'auto'; focus: string; analyzed_at: string | null; next_style: string | null; extra_skills: string[];
}
export interface Video {
  id: number; project_id: number; title: string; topic: string; stage: Stage; status: Status;
  error: string | null; note: string | null; produce_attempts: number; retry_at: string | null; archived_from: string | null;
  scheduled_at: string | null; created_at: string; updated_at: string; visibility: Visibility;
}
export const STAGES = ['research', 'script', 'production', 'produce', 'check', 'approval', 'publish', 'done'] as const;
export type Stage = (typeof STAGES)[number];
export type Status =
  | 'queued' | 'running' | 'waiting_usage' | 'failed' | 'awaiting_review' | 'awaiting_approval'
  | 'scheduled' | 'ready_to_publish' | 'published' | 'rejected' | 'archived';

const bool = (v: unknown) => v === 1 || v === true;
export function toProject(r: Row): Project {
  return {
    ...r,
    styles: JSON.parse(r.styles), post_times: JSON.parse(r.post_times), post_days: JSON.parse(r.post_days), extra_skills: JSON.parse(r.extra_skills || '[]'),
    voice: bool(r.voice), music: bool(r.music), captions: bool(r.captions), autopilot: bool(r.autopilot),
    auto_publish: bool(r.auto_publish), active: bool(r.active),
    production_step: bool(r.production_step), review_steps: bool(r.review_steps),
    channel_ids: all<{ channel_id: number }>('SELECT channel_id FROM project_channels WHERE project_id=?', r.id).map((x) => x.channel_id),
  } as Project;
}
export const getProject = (id: number) => { const r = get('SELECT * FROM projects WHERE id=?', id); return r ? toProject(r) : undefined; };
export const getVideo = (id: number) => get<Video>('SELECT * FROM videos WHERE id=?', id);

export function updateVideo(id: number, fields: Partial<Video>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  run(`UPDATE videos SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`,
    ...keys.map((k) => (fields as any)[k] ?? null), now(), id);
}

export function getSetting<T>(key: string, fallback: T): T {
  const r = get<{ value: string }>('SELECT value FROM settings WHERE key=?', key);
  return r ? (JSON.parse(r.value) as T) : fallback;
}
export function setSetting(key: string, value: unknown) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}
