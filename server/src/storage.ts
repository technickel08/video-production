import fs from 'node:fs';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { all, db, getSetting, getVideo } from './db.ts';
import { DATA_DIR, videoDir } from './paths.ts';

/**
 * Optional S3 storage (AWS S3 or anything S3-compatible: Cloudflare R2, MinIO, Backblaze…).
 * Local disk stays the working folder; S3 holds a durable copy of every deliverable, gives Instagram a
 * download link without a tunnel, and lets a new machine restore its files.
 */
interface Cfg { bucket: string; region: string; endpoint: string; prefix: string; keyId: string; secret: string }

function cfg(): Cfg {
  return {
    bucket: getSetting('s3_bucket', '') || process.env.S3_BUCKET || '',
    region: getSetting('s3_region', '') || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    endpoint: (getSetting('s3_endpoint', '') || process.env.S3_ENDPOINT || '').replace(/\/$/, ''),
    prefix: (getSetting('s3_prefix', '') || 'video-autopilot').replace(/^\/+|\/+$/g, ''),
    keyId: getSetting('s3_access_key_id', '') || process.env.AWS_ACCESS_KEY_ID || '',
    secret: getSetting('s3_secret_access_key', '') || process.env.AWS_SECRET_ACCESS_KEY || '',
  };
}
export const s3Configured = () => !!cfg().bucket;

// ─── Credentials: saved keys, environment, or the EC2 instance role ──────────
let roleCreds: { keyId: string; secret: string; token: string; expires: number } | null = null;
const IMDS = () => process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT || 'http://169.254.169.254';

async function instanceRole() {
  if (roleCreds && roleCreds.expires - Date.now() > 5 * 60_000) return roleCreds;
  const t = (ms: number) => AbortSignal.timeout(ms);
  const token = await fetch(`${IMDS()}/latest/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' }, signal: t(1500) }).then((r) => r.text());
  const h = { 'x-aws-ec2-metadata-token': token };
  const base = `${IMDS()}/latest/meta-data/iam/security-credentials/`;
  const role = (await fetch(base, { headers: h, signal: t(1500) }).then((r) => (r.ok ? r.text() : ''))).split('\n')[0].trim();
  if (!role) throw new Error('no role');
  const c: any = await fetch(base + role, { headers: h, signal: t(1500) }).then((r) => r.json());
  roleCreds = { keyId: c.AccessKeyId, secret: c.SecretAccessKey, token: c.Token, expires: new Date(c.Expiration).getTime() };
  return roleCreds;
}

async function client(): Promise<{ aws: AwsClient; c: Cfg }> {
  const c = cfg();
  if (!c.bucket) throw new Error('S3 is not set up: add a bucket in Settings → Cloud storage.');
  let keyId = c.keyId, secret = c.secret, sessionToken = process.env.AWS_SESSION_TOKEN && !getSetting('s3_access_key_id', '') ? process.env.AWS_SESSION_TOKEN : undefined;
  if (!keyId || !secret) {
    try { const r = await instanceRole(); keyId = r.keyId; secret = r.secret; sessionToken = r.token; }
    catch { throw new Error('No S3 credentials: enter an access key in Settings → Cloud storage, or attach an IAM role with S3 access to this EC2 instance.'); }
  }
  return { aws: new AwsClient({ accessKeyId: keyId, secretAccessKey: secret, sessionToken, service: 's3', region: c.region, retries: 2 }), c };
}

/** Path-style URLs work with AWS and every S3-compatible service, and with bucket names that contain dots. */
const objectUrl = (c: Cfg, key: string) =>
  `${c.endpoint || `https://s3.${c.region}.amazonaws.com`}/${c.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
const fullKey = (c: Cfg, key: string) => `${c.prefix ? `${c.prefix}/` : ''}${key}`;

async function fail(op: string, r: Response): Promise<never> {
  const body = await r.text().catch(() => '');
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1]; const msg = body.match(/<Message>([^<]+)<\/Message>/)?.[1];
  throw new Error(`S3 ${op} failed: ${r.status} ${code ?? ''} ${msg ?? ''}`.trim().slice(0, 300));
}

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.srt': 'text/plain; charset=utf-8', '.db': 'application/octet-stream' };

export async function putFile(key: string, file: string) {
  const { aws, c } = await client();
  const r = await aws.fetch(objectUrl(c, fullKey(c, key)), {
    method: 'PUT', body: fs.readFileSync(file),
    headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
  });
  if (!r.ok) await fail('upload', r);
}

export async function getToFile(key: string, file: string) {
  const { aws, c } = await client();
  const r = await aws.fetch(objectUrl(c, fullKey(c, key)));
  if (!r.ok) await fail('download', r);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

/** A time-limited public download link for one object. */
export async function presign(key: string, seconds = 3600): Promise<string> {
  const { aws, c } = await client();
  const signed = await aws.sign(`${objectUrl(c, fullKey(c, key))}?X-Amz-Expires=${seconds}`, { method: 'GET', aws: { signQuery: true } });
  return signed.url;
}

async function listKeys(prefix: string): Promise<{ key: string; size: number }[]> {
  const { aws, c } = await client();
  const out: { key: string; size: number }[] = [];
  let token = '';
  do {
    const q = new URLSearchParams({ 'list-type': '2', prefix: fullKey(c, prefix), ...(token ? { 'continuation-token': token } : {}) });
    const r = await aws.fetch(`${c.endpoint || `https://s3.${c.region}.amazonaws.com`}/${c.bucket}?${q}`);
    if (!r.ok) await fail('list', r);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) {
      const k = m[1].replace(/&amp;/g, '&');
      out.push({ key: c.prefix ? k.slice(c.prefix.length + 1) : k, size: Number(m[2]) });
    }
    token = xml.match(/<NextContinuationToken>([^<]+)</)?.[1] ?? '';
  } while (token);
  return out;
}

async function deleteKey(key: string) {
  const { aws, c } = await client();
  const r = await aws.fetch(objectUrl(c, fullKey(c, key)), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) await fail('delete', r);
}

// ─── Videos ──────────────────────────────────────────────────────────────────
/** What is kept in S3: everything you would review or publish. The working film folder and logs stay local. */
const KEEP = /^(final\.mp4|poster\.jpg|captions\.srt|research\.md|topics\.json|script\.md|metadata\.json|hook\.json|production\.(md|json)|check\.json|review\.json|grid\.jpg|hook\.jpg)$/;
const videoKey = (projectId: number, videoId: number, rel = '') => `projects/p${projectId}/v${videoId}/${rel}`;

/** Upload a video's new or changed deliverables. Returns how many files were sent. */
export async function syncVideo(videoId: number): Promise<number> {
  if (!s3Configured()) return 0;
  const v = getVideo(videoId); if (!v) return 0;
  const dir = videoDir(v.project_id, v.id);
  if (!fs.existsSync(dir)) return 0;
  const manifestFile = path.join(dir, '.s3.json');
  let manifest: Record<string, string> = {}; try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch {}
  let sent = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!KEEP.test(f)) continue;
    const st = fs.statSync(path.join(dir, f)); const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (manifest[f] === stamp) continue;
    await putFile(videoKey(v.project_id, v.id, f), path.join(dir, f));
    manifest[f] = stamp; sent++;
  }
  if (sent) fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return sent;
}

/** Fire-and-forget upload after a step; a storage problem must never fail the pipeline. */
export function syncVideoSoon(videoId: number) {
  if (!s3Configured()) return;
  syncVideo(videoId).catch((e) => console.error(`[s3] video ${videoId}: ${e.message}`));
}

/** Download link for a video's file, uploading it first if S3 does not have the current version. */
export async function videoFileLink(videoId: number, rel: string, seconds = 3600): Promise<string> {
  const v = getVideo(videoId); if (!v) throw new Error('video not found');
  await syncVideo(videoId);
  return presign(videoKey(v.project_id, v.id, rel), seconds);
}

/** Link for a file that exists in S3 but not on this disk (after moving to a new machine). */
export async function missingFileLink(videoId: number, rel: string): Promise<string | null> {
  if (!s3Configured() || !KEEP.test(rel)) return null;
  const v = getVideo(videoId); if (!v) return null;
  return presign(videoKey(v.project_id, v.id, rel), 900);
}

export async function deleteVideoFiles(projectId: number, videoId: number) {
  if (!s3Configured()) return;
  for (const o of await listKeys(videoKey(projectId, videoId))) await deleteKey(o.key);
}

/** Upload everything that is not in S3 yet. */
export async function syncAll(): Promise<{ videos: number; files: number }> {
  let files = 0; const vids = all<{ id: number }>('SELECT id FROM videos');
  for (const v of vids) files += await syncVideo(v.id);
  return { videos: vids.length, files };
}

/** Download deliverables that S3 has and this disk lacks, for videos in the database. */
export async function restoreAll(): Promise<{ files: number }> {
  let files = 0;
  for (const v of all<{ id: number; project_id: number }>('SELECT id, project_id FROM videos')) {
    const dir = videoDir(v.project_id, v.id);
    for (const o of await listKeys(videoKey(v.project_id, v.id))) {
      const rel = o.key.slice(videoKey(v.project_id, v.id).length);
      if (!KEEP.test(rel) || fs.existsSync(path.join(dir, rel))) continue;
      await getToFile(o.key, path.join(dir, rel)); files++;
    }
  }
  return { files };
}

// ─── Database backup ─────────────────────────────────────────────────────────
/** Snapshot the database to S3 (latest + one per day). Sign-in tokens inside stay encrypted with data/secret.key, which is never uploaded. */
export async function backupDatabase(): Promise<string> {
  const snap = path.join(DATA_DIR, 'backup.db');
  fs.rmSync(snap, { force: true });
  db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  try {
    const day = new Date().toISOString().slice(0, 10);
    await putFile(`backups/app-${day}.db`, snap);
    await putFile('backups/app-latest.db', snap);
    return `backups/app-${day}.db`;
  } finally { fs.rmSync(snap, { force: true }); }
}

let lastBackup = 0;
/** Called on a timer: back up at most every 6 hours. */
export async function backupTick() {
  if (!s3Configured() || Date.now() - lastBackup < 6 * 3600_000) return;
  lastBackup = Date.now();
  await backupDatabase();
}

/** Write, read back and delete a small object to prove the bucket and credentials work. */
export async function testS3(): Promise<string> {
  const { c } = await client();
  const key = `healthcheck-${Date.now()}.txt`; const tmp = path.join(DATA_DIR, 'tmp', key);
  fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.writeFileSync(tmp, 'ok');
  try {
    await putFile(key, tmp);
    const r = await fetch(await presign(key, 60));
    if (!r.ok || (await r.text()) !== 'ok') throw new Error(`Uploaded, but the download link did not work (${r.status}).`);
    await deleteKey(key);
    return `Connected to bucket “${c.bucket}” (${c.endpoint || c.region}); upload, download link and delete all work.`;
  } finally { fs.rmSync(tmp, { force: true }); }
}
