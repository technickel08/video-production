import { Hono } from 'hono';
import { missingFileLink, backupTick } from './storage.ts';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { api, serveArtifact } from './api.ts';
import { recover, tick, autopilot, busy } from './pipeline.ts';
import { publishTick, statsTick } from './publish.ts';
import { learningTick } from './learning.ts';
import { scoutTick } from './skills.ts';
import { WEB_DIST, PORT, ROOT, HOST, BASE_URL } from './paths.ts';
import { guard, authRequired, applyEnvPassword } from './auth.ts';

applyEnvPassword();
const local = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
if (!local && !authRequired()) {
  console.error(`Refusing to start: HOST=${HOST} makes the dashboard reachable from other machines, but no admin password is set.\nSet one first:  ADMIN_PASSWORD='a-long-password' npm start   (or: npm run admin-password -- 'a-long-password')`);
  process.exit(1);
}

const app = new Hono();
app.use('/api/*', guard);
app.use('/files/*', guard);
app.route('/api', api);

app.get('/files/:videoId/*', async (c) => {
  const rel = decodeURIComponent(c.req.path.split('/').slice(3).join('/'));
  const r = serveArtifact(Number(c.req.param('videoId')), rel, c.req.header('range'));
  if (!r) {
    // Not on this disk (for example after moving to a new machine): send the browser to the S3 copy.
    const link = await missingFileLink(Number(c.req.param('videoId')), rel).catch(() => null);
    return link ? c.redirect(link, 302) : c.text('Not found', 404);
  }
  return new Response(Readable.toWeb(r.stream) as ReadableStream, { status: r.status, headers: r.headers });
});

app.use('/*', serveStatic({ root: path.relative(process.cwd(), WEB_DIST) }));
app.get('*', (c) => {
  const index = path.join(WEB_DIST, 'index.html');
  return fs.existsSync(index) ? c.html(fs.readFileSync(index, 'utf8')) : c.text('Dashboard not built yet: run `npm run build` (or use `npm run dev`).', 404);
});

recover();
serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => console.log(`Video Autopilot running at ${BASE_URL}${local ? '' : ` (listening on ${HOST}:${PORT})`}${authRequired() ? ' — sign-in required' : ''}`));

// Background loops
const safe = (name: string, fn: () => unknown) => async () => { try { await fn(); } catch (e: any) { console.error(`[${name}]`, e?.message || e); } };
setInterval(safe('pipeline', tick), 3000);
setInterval(safe('autopilot', autopilot), 60_000);
setInterval(safe('publish', publishTick), 30_000);
setInterval(safe('stats', () => statsTick()), 15 * 60_000);
setInterval(safe('backup', backupTick), 10 * 60_000);
setInterval(safe('learning', learningTick), 10 * 60_000);
setInterval(safe('scout', scoutTick), 30 * 60_000);
setTimeout(safe('autopilot', autopilot), 5000);

// Keep the Mac awake only while a video is being worked on.
let caffeinate: ChildProcess | null = null;
setInterval(() => {
  if (process.platform !== 'darwin') return;
  if (busy() !== null && !caffeinate) caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  else if (busy() === null && caffeinate) { caffeinate.kill(); caffeinate = null; }
}, 5000);

process.on('SIGINT', () => { caffeinate?.kill(); process.exit(0); });
process.on('SIGTERM', () => { caffeinate?.kill(); process.exit(0); });
void ROOT;
