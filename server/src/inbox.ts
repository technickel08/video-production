import { all, get, run, now } from './db.ts';
import { changed, notify } from './events.ts';

/**
 * The dashboard's "What's new" feed. `ref` ties a note to something you can act on from it,
 * e.g. "proposal:12" (approve / dismiss / undo) or "skill:3" (add / dismiss).
 */
export type NoteKind = 'playbook' | 'proposal' | 'applied' | 'skill_found' | 'skill_added' | 'scout' | 'info';
export interface Note { id: number; kind: NoteKind; title: string; body: string; link: string | null; ref: string | null; created_at: string; read_at: string | null }

export function addNote(kind: NoteKind, title: string, body = '', opts: { link?: string; ref?: string; mac?: boolean } = {}) {
  const r = run('INSERT INTO notifications(kind, title, body, link, ref, created_at) VALUES (?,?,?,?,?,?)', kind, title, body, opts.link ?? null, opts.ref ?? null, now());
  if (opts.mac !== false) notify(title, body.split('\n')[0].slice(0, 140));
  changed('inbox');
  return Number(r.lastInsertRowid);
}

export const listNotes = (limit = 100) => all<Note>('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', limit);
export const unreadCount = () => get<{ n: number }>('SELECT COUNT(*) n FROM notifications WHERE read_at IS NULL')!.n;

export function markRead(ids?: number[]) {
  if (ids?.length) run(`UPDATE notifications SET read_at=? WHERE read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, now(), ...ids);
  else run('UPDATE notifications SET read_at=? WHERE read_at IS NULL', now());
  changed('inbox');
}
