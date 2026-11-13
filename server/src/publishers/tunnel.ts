import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { Resolver } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { bin as cloudflaredBin, install as installCloudflared } from 'cloudflared';
import { getSetting } from '../db.ts';

/**
 * Make one local file reachable at a public HTTPS URL for a short time (Instagram downloads it from there).
 * A tiny server serves only that file under a random path, and a Cloudflare quick tunnel points at that server,
 * so the dashboard itself is never exposed. `public_base_url` (e.g. a reverse proxy) skips the tunnel.
 */
export async function shareFile(file: string): Promise<{ url: string; close: () => Promise<void> }> {
  const token = crypto.randomBytes(16).toString('hex');
  const name = `${token}.mp4`;
  const size = fs.statSync(file).size;
  const server = http.createServer((req, res) => {
    if (req.url !== `/${name}` || !['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(404).end(); return; }
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]); const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const closeServer = () => new Promise<void>((r) => server.close(() => r()));

  const base = getSetting<string>('public_base_url', '') || process.env.PUBLIC_BASE_URL || '';
  if (base) return { url: `${base.replace(/\/$/, '')}/${name}`.replace('{port}', String(port)), close: closeServer };

  if (!fs.existsSync(cloudflaredBin)) await installCloudflared(cloudflaredBin);
  const proc = spawn(cloudflaredBin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const close = async () => { proc.kill('SIGTERM'); await closeServer(); };
  let log = '';
  try {
    // The address is printed before the tunnel is actually connected, so wait for the connection too.
    const publicBase = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Cloudflare tunnel did not connect within 90s. ${lastLines(log)}`)), 90_000);
      const onData = (d: Buffer) => {
        log = (log + d.toString()).slice(-8000);
        const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && /Registered tunnel connection/.test(log)) { clearTimeout(t); resolve(m[0]); }
      };
      proc.stdout.on('data', onData); proc.stderr.on('data', onData);
      proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`cloudflared exited (${c}). ${lastLines(log)}`)); });
    });
    const url = `${publicBase}/${name}`;
    // Check the link the way Instagram will see it: through public DNS, not this Mac's resolver.
    // (A brand-new tunnel name often fails on the local resolver for minutes, because the "not found" answer gets cached.)
    let last = '';
    for (let i = 0; i < 45; i++) {
      try { const code = await headViaPublicDns(url); if (code >= 200 && code < 300) return { url, close }; last = `HTTP ${code}`; }
      catch (e: any) { last = e?.code || e?.message || String(e); }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Public link for the video never became reachable (${last}). ${lastLines(log)}`);
  } catch (e) { await close(); throw e; }
}

const lastLines = (log: string) => {
  const errs = log.split('\n').filter((l) => /ERR|error|failed/i.test(l)).slice(-2).map((l) => l.replace(/^\S+\s+/, '').trim());
  return errs.length ? `cloudflared: ${errs.join(' | ').slice(0, 400)}` : '';
};

/** HEAD request to an https URL, resolving the host through public DNS servers and connecting to that address. */
async function headViaPublicDns(url: string): Promise<number> {
  const u = new URL(url);
  const resolver = new Resolver({ timeout: 4000, tries: 1 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const [ip] = await resolver.resolve4(u.hostname);
  if (!ip) throw new Error('no address yet');
  return new Promise<number>((resolve, reject) => {
    const req = https.request({ host: ip, servername: u.hostname, port: 443, path: u.pathname, method: 'HEAD', headers: { host: u.hostname }, timeout: 10_000 },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}
