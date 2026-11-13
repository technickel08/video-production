import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { getSetting } from './db.ts';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

/** Tell connected dashboards that something changed. */
export function changed(kind: string, id?: number, extra?: Record<string, unknown>) {
  bus.emit('event', { kind, id, ...extra });
}

/** Stream a log line to dashboards watching a video. */
export function logLine(videoId: number, stage: string, line: unknown) {
  bus.emit('event', { kind: 'log', id: videoId, stage, line });
}

export function notify(title: string, message: string) {
  if (!getSetting('notifications', true) || process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${esc(message)}" with title "Video Autopilot" subtitle "${esc(title)}"`], () => {});
}
