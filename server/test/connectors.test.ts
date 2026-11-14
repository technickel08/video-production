// End-to-end test of the YouTube and Instagram connectors against fake platform servers.
// Covers OAuth callback → channel saved → approve → publish (YouTube resumable upload with publishAt,
// Instagram Reels container → poll → publish through a public file link) → video marked published → stats.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'va-test-'));
process.env.VA_DATA_DIR = tmp;
process.env.IG_POLL_MS = '5';

const seen: Record<string, any> = { ytUploads: [], igContainers: [] };
let base = '';
let fakeLoginEmail = '';
const FAKE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
/** A GitHub-style source archive: <repo>-<sha>/ with a README at the root and the skill in skills/demo. */
function fakeTarball() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'va-tar-'));
  const top = path.join(root, `video-skill-${FAKE_SHA}`);
  fs.mkdirSync(path.join(top, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(top, 'README.md'), 'repo readme');
  fs.writeFileSync(path.join(top, 'skills', 'demo', 'SKILL.md'), '# Demo skill\n');
  execFileSync('tar', ['-czf', path.join(root, 'out.tar.gz'), '-C', root, `video-skill-${FAKE_SHA}`]);
  return path.join(root, 'out.tar.gz');
}

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url!, base);
  const body = await new Promise<string>((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });
  const json = (o: unknown, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(o)); };
  const p = url.pathname;

  // Google
  if (p === '/token') {
    const f = new URLSearchParams(body);
    return json(f.get('grant_type') === 'refresh_token' ? { access_token: 'yt-at-2', expires_in: 3600 } : { access_token: 'yt-at', refresh_token: 'yt-rt', expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly' });
  }
  if (p === '/userinfo') return json({ email: fakeLoginEmail, email_verified: true });
  if (p === '/youtube/v3/channels') return json({ items: [{ id: 'UC123', snippet: { title: 'Test Channel' } }] });
  if (p === '/upload/youtube/v3/videos') {
    assert.equal(req.headers.authorization, 'Bearer yt-at');
    seen.ytUploads.push(JSON.parse(body));
    return json({}, 200, { location: `${base}/upload-session/${seen.ytUploads.length}` });
  }
  if (p.startsWith('/upload-session/')) { seen.ytBytes = body.length; return json({ id: `yt-${p.split('/').pop()}` }); }
  if (p === '/upload/youtube/v3/thumbnails/set') return json({});
  if (p === '/v2/reports') {
    if (url.searchParams.get('dimensions') === 'video') {
      const ids = url.searchParams.get('filters')!.replace('video==', '').split(',');
      return json({ columnHeaders: ['video', 'averageViewDuration', 'averageViewPercentage', 'subscribersGained', 'shares'].map((name) => ({ name })), rows: ids.map((id) => [id, 27, 61.5, 3, 4]) });
    }
    return json({ rows: Array.from({ length: 100 }, (_, i) => [(i + 1) / 100, Math.round((1 - i / 200) * 100) / 100 - 0.045]) });
  }
  if (p === '/youtube/v3/commentThreads') return json({ items: ['More of these please', 'Source?'].map((t) => ({ snippet: { topLevelComment: { snippet: { textDisplay: t } } } })) });
  if (p === '/repos/example/video-skill/commits/HEAD') return json({ sha: FAKE_SHA });
  if (p === `/example/video-skill/tar.gz/${FAKE_SHA}`) { res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(fs.readFileSync(fakeTarball())); return; }
  if (p === '/youtube/v3/videos') return json({ items: url.searchParams.get('id')!.split(',').map((id) => ({ id, statistics: { viewCount: '120', likeCount: '9', commentCount: '2' } })) });

  // Meta Graph
  if (p === '/v21.0/oauth/access_token') return json(url.searchParams.get('fb_exchange_token') ? { access_token: 'ig-long', expires_in: 5184000 } : { access_token: 'ig-short' });
  if (p === '/v21.0/me/accounts') return json({ data: [{ name: 'Page', instagram_business_account: { id: 'ig1', username: 'tester' } }] });
  if (p === '/v21.0/ig1/media') {
    const f = new URLSearchParams(body);
    const video = await fetch(f.get('video_url')!); // Instagram downloads the file from the public link
    seen.igContainers.push({ ...Object.fromEntries(f), fetched: video.status, bytes: (await video.arrayBuffer()).byteLength });
    return json({ id: 'c1' });
  }
  if (p === '/v21.0/c1') return json({ status_code: 'FINISHED' });
  if (p === '/v21.0/ig1/media_publish') return json({ id: 'm1' });
  if (p === '/v21.0/m1') return json({ permalink: 'https://instagram.com/p/m1' });
  if (p === '/v21.0/m1/insights') return json({ data: [{ name: 'views', values: [{ value: 340 }] }, { name: 'reach', values: [{ value: 300 }] }, { name: 'ig_reels_avg_watch_time', values: [{ value: 12400 }] }] });
  json({ error: { message: `unexpected ${req.method} ${p}` } }, 404);
});

let m: any;
before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as any).port}`;
  Object.assign(process.env, { YT_OAUTH_BASE: base, YT_API_BASE: base, YT_AUTH_BASE: base, GRAPH_BASE: base, FB_DIALOG_BASE: base, GOOGLE_USERINFO_URL: `${base}/userinfo`, YT_ANALYTICS_BASE: base, GITHUB_API_BASE: base, GITHUB_CODELOAD_BASE: base });
  const db = await import('../src/db.ts');
  m = {
    db, pipeline: await import('../src/pipeline.ts'), publish: await import('../src/publish.ts'),
    yt: await import('../src/publishers/youtube.ts'), ig: await import('../src/publishers/instagram.ts'), paths: await import('../src/paths.ts'),
    tools: await import('../src/tools.ts'),
  };
  for (const [k, v] of Object.entries({ youtube_client_id: 'cid', youtube_client_secret: 'cs', meta_app_id: 'aid', meta_app_secret: 'as', public_base_url: 'http://127.0.0.1:{port}', notifications: false })) db.setSetting(k, v);
});
after(() => { fake.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function makeFinishedVideo(projectId: number) {
  const v = m.pipeline.createVideo(projectId);
  const dir = m.paths.videoDir(projectId, v.id);
  await m.tools.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(dir, 'final.mp4')]);
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ title: 'Why Mars is red', description: 'Iron oxide.', hashtags: ['#space', '#mars'] }));
  m.db.updateVideo(v.id, { stage: 'approval', status: 'awaiting_approval', title: 'Why Mars is red' });
  return v.id as number;
}

test('OAuth URLs carry client id, redirect and state', () => {
  const yt = new URL(m.yt.authUrl('s1'));
  assert.equal(yt.searchParams.get('client_id'), 'cid');
  assert.equal(yt.searchParams.get('access_type'), 'offline');
  assert.match(yt.searchParams.get('redirect_uri')!, /\/api\/oauth\/youtube\/callback$/);
  const ig = new URL(m.ig.authUrl('s2'));
  assert.equal(ig.searchParams.get('client_id'), 'aid');
  assert.match(ig.searchParams.get('scope')!, /instagram_content_publish/);
});

test('connect, approve, publish and collect stats', async () => {
  const [ytChannel] = await m.yt.handleCallback('code-1');
  const [igChannel] = await m.ig.handleCallback('code-2');
  const channels = m.db.all('SELECT platform, name, external_id FROM channels ORDER BY id');
  assert.deepEqual(channels.map((c: any) => [c.platform, c.name, c.external_id]), [['youtube', 'Test Channel', 'UC123'], ['instagram', '@tester', 'ig1']]);
  // tokens are stored encrypted
  assert.ok(!m.db.get('SELECT tokens FROM channels WHERE id=?', ytChannel).tokens.includes('yt-rt'));

  const pid = Number(m.db.run(`INSERT INTO projects(name, niche, created_at) VALUES ('P','space',?)`, new Date().toISOString()).lastInsertRowid);
  m.db.run('INSERT INTO project_channels VALUES (?,?),(?,?)', pid, ytChannel, pid, igChannel);

  // 1) Due now → YouTube public upload + Instagram Reel posted immediately
  const v1 = await makeFinishedVideo(pid);
  m.pipeline.approve(v1, new Date(Date.now() - 1000).toISOString());
  await m.publish.publishTick();
  const posts1 = m.db.all('SELECT platform, status, external_id, url, error FROM posts WHERE video_id=? ORDER BY platform', v1);
  assert.deepEqual(posts1.map((p: any) => [p.platform, p.status, p.error]), [['instagram', 'published', null], ['youtube', 'published', null]]);
  assert.equal(posts1[1].external_id, 'yt-1');
  assert.equal(seen.ytUploads[0].status.privacyStatus, 'public');
  assert.equal(seen.ytUploads[0].status.containsSyntheticMedia, true);
  assert.ok(seen.ytBytes > 1000, 'video bytes were uploaded');
  assert.equal(seen.igContainers[0].media_type, 'REELS');
  assert.equal(seen.igContainers[0].fetched, 200);
  assert.equal(seen.igContainers[0].bytes, fs.statSync(path.join(m.paths.videoDir(pid, v1), 'final.mp4')).size);
  assert.equal(m.db.getVideo(v1).status, 'published');

  // 2) Future time → YouTube uploads ahead as private + publishAt; Instagram waits
  const v2 = await makeFinishedVideo(pid);
  const when = new Date(Date.now() + 2 * 86400_000);
  m.pipeline.approve(v2, when.toISOString());
  await m.publish.publishTick();
  const posts2 = Object.fromEntries(m.db.all('SELECT platform, status FROM posts WHERE video_id=?', v2).map((p: any) => [p.platform, p.status]));
  assert.deepEqual(posts2, { youtube: 'scheduled', instagram: 'pending' });
  assert.equal(seen.ytUploads[1].status.privacyStatus, 'private');
  assert.equal(seen.ytUploads[1].status.publishAt, when.toISOString());
  assert.equal(seen.igContainers.length, 1, 'instagram did not post early');
  assert.equal(m.db.getVideo(v2).status, 'scheduled');

  // 3) Stats
  await m.publish.statsTick(true);
  const stats = m.db.all('SELECT p.platform, s.views, s.likes FROM stats s JOIN posts p ON p.id=s.post_id ORDER BY p.platform');
  assert.deepEqual(stats.map((s: any) => [s.platform, s.views]), [['instagram', 340], ['youtube', 120]]);
});

test('approval without channels waits as ready_to_publish', async () => {
  const pid = Number(m.db.run(`INSERT INTO projects(name, niche, created_at) VALUES ('Q','x',?)`, new Date().toISOString()).lastInsertRowid);
  const v = await makeFinishedVideo(pid);
  m.pipeline.approve(v);
  assert.equal(m.db.getVideo(v).status, 'ready_to_publish');
  assert.ok(new Date(m.db.getVideo(v).scheduled_at).getTime() > Date.now());
});

test('next slot respects posting days, times and taken slots', async () => {
  const pid = Number(m.db.run(`INSERT INTO projects(name, niche, post_times, post_days, created_at) VALUES ('S','x','["09:00","18:00"]','[1]',?)`, new Date().toISOString()).lastInsertRowid);
  const p = m.db.getProject(pid);
  const from = new Date(2026, 10, 9, 12, 0); // Monday 12:00 local
  const slot = new Date(m.pipeline.nextSlot(p, undefined, from));
  assert.equal(slot.getDay(), 1); assert.equal(slot.getHours(), 18);
});

test('usage-limit reset time parsing', async () => {
  const { parseReset } = await import('../src/claude.ts');
  const from = new Date(2026, 10, 9, 13, 0);
  assert.equal(new Date(parseReset('Claude AI usage limit reached|1794261600', from)).getTime(), 1794261600 * 1000 + 60_000);
  const r = new Date(parseReset("You've hit your limit · resets 3pm (Asia/Kolkata)", from));
  assert.equal(r.getHours(), 15);
  const later = new Date(parseReset('limit reached, resets in 2h 10m', from));
  assert.equal(Math.round((later.getTime() - from.getTime()) / 60000), 131);
});

test('orphaned scheduled video is repaired, and publish-now uploads immediately', async () => {
  const pid = Number(m.db.run(`INSERT INTO projects(name, niche, created_at) VALUES ('R','x',?)`, new Date().toISOString()).lastInsertRowid);
  const ch = m.db.get(`SELECT id FROM channels WHERE platform='youtube'`).id;
  m.db.run('INSERT INTO project_channels VALUES (?,?)', pid, ch);
  const v = await makeFinishedVideo(pid);
  m.pipeline.approve(v, new Date(Date.now() + 3 * 86400_000).toISOString());
  // Simulate the channel's posts disappearing (channel removed and reconnected)
  m.db.run('DELETE FROM posts WHERE video_id=?', v);
  m.publish.repairOrphans();
  const repaired = m.db.all('SELECT status FROM posts WHERE video_id=?', v);
  assert.equal(repaired.length, 1, 'a post was recreated for the linked channel');

  // Publish now: the pending YouTube post goes out public right away
  m.db.run(`UPDATE posts SET status='pending' WHERE video_id=?`, v);
  const before = seen.ytUploads.length;
  await m.publish.publishNow(v);
  await new Promise((r) => setTimeout(r, 300));
  await m.publish.publishTick();
  assert.equal(seen.ytUploads.length, before + 1);
  assert.equal(seen.ytUploads.at(-1).status.privacyStatus, 'public');
  assert.equal(m.db.getVideo(v).status, 'published');

  // Orphan with no channel left → ready to publish
  const pid2 = Number(m.db.run(`INSERT INTO projects(name, niche, created_at) VALUES ('R2','x',?)`, new Date().toISOString()).lastInsertRowid);
  const v2 = await makeFinishedVideo(pid2);
  m.db.updateVideo(v2, { stage: 'publish', status: 'scheduled', scheduled_at: new Date(Date.now() + 86400_000).toISOString() });
  m.publish.repairOrphans();
  assert.equal(m.db.getVideo(v2).status, 'ready_to_publish');
});

test('private and unlisted uploads: exact YouTube privacy, no early upload, Instagram skipped', async () => {
  const yt = m.db.get(`SELECT id FROM channels WHERE platform='youtube'`).id;
  const ig = m.db.get(`SELECT id FROM channels WHERE platform='instagram'`).id;
  const pid = Number(m.db.run(`INSERT INTO projects(name, niche, visibility, created_at) VALUES ('V','x','unlisted',?)`, new Date().toISOString()).lastInsertRowid);
  m.db.run('INSERT INTO project_channels VALUES (?,?),(?,?)', pid, yt, pid, ig);

  // Project default (unlisted), due now → uploaded unlisted, no Instagram post
  const v1 = await makeFinishedVideo(pid);
  m.pipeline.approve(v1, new Date(Date.now() - 1000).toISOString());
  assert.equal(m.db.getVideo(v1).visibility, 'unlisted');
  assert.deepEqual(m.db.all('SELECT platform FROM posts WHERE video_id=?', v1).map((p: any) => p.platform), ['youtube']);
  await m.publish.publishTick();
  assert.equal(seen.ytUploads.at(-1).status.privacyStatus, 'unlisted');
  assert.equal(seen.ytUploads.at(-1).status.publishAt, undefined);

  // Private chosen at approval for a future time → waits (no upload ahead)
  const v2 = await makeFinishedVideo(pid);
  const before = seen.ytUploads.length;
  m.pipeline.approve(v2, new Date(Date.now() + 86400_000).toISOString(), 'private');
  await m.publish.publishTick();
  assert.equal(seen.ytUploads.length, before, 'private video not uploaded before its time');
  await m.publish.publishNow(v2);
  await new Promise((r) => setTimeout(r, 300));
  await m.publish.publishTick();
  assert.equal(seen.ytUploads.at(-1).status.privacyStatus, 'private');

  const v3 = await makeFinishedVideo(pid);
  assert.throws(() => m.pipeline.approve(v3, undefined, 'secret'), /visibility/);
});

test('redo after stop carries feedback to the chosen step; voice choices reach the brief', async () => {
  const pid = Number(m.db.run(`INSERT INTO projects(name, niche, created_at) VALUES ('R','x',?)`, new Date().toISOString()).lastInsertRowid);
  const v = m.pipeline.createVideo(pid).id as number;
  m.db.updateVideo(v, { stage: 'produce', status: 'running' });
  m.pipeline.reject(v, '');                                   // Stop
  assert.equal(m.db.getVideo(v).status, 'rejected');
  m.pipeline.retry(v, 'script', 'Start with the twist\nshorter sentences');
  const after = m.db.getVideo(v);
  assert.equal(after.stage, 'script'); assert.equal(after.status, 'queued');
  assert.equal(after.note, '- Start with the twist\n- shorter sentences');
  m.pipeline.retry(v, 'produce');                             // no feedback keeps the list
  assert.equal(m.db.getVideo(v).note, '- Start with the twist\n- shorter sentences');

  const { voiceBrief } = await import('../src/voices.ts');
  const brief = voiceBrief({ voice: true, voice_name: 'bm_george', voice_speed: 0.85, voice_style: 'calm documentary' });
  assert.match(brief, /bm_george/); assert.match(brief, /"lang": "en-gb"/); assert.match(brief, /0\.85/); assert.match(brief, /calm documentary/);
  assert.equal(voiceBrief({ voice: false, voice_name: 'bm_george', voice_speed: 0, voice_style: '' }), 'none — no narration');
});

test('step reviews pause after research, script and production; Production is optional', async () => {
  m.db.setSetting('mock_mode', true);
  m.db.run(`UPDATE videos SET status='rejected' WHERE status IN ('queued','waiting_usage')`);   // leftovers from earlier tests
  const tickUntilIdle = async () => { await m.pipeline.tick(); };
  const pid = Number(m.db.run(`INSERT INTO projects(name, niche, duration_sec, created_at) VALUES ('S','x',2,?)`, new Date().toISOString()).lastInsertRowid);
  const v = m.pipeline.createVideo(pid).id as number;
  const at = () => { const x = m.db.getVideo(v); return `${x.stage}/${x.status}`; };

  await tickUntilIdle(); assert.equal(at(), 'research/awaiting_review');
  await tickUntilIdle(); assert.equal(at(), 'research/awaiting_review');           // nothing runs while waiting
  m.pipeline.approveStep(v); assert.equal(at(), 'script/queued');
  await tickUntilIdle(); assert.equal(at(), 'script/awaiting_review');
  m.pipeline.retry(v, 'script', 'punchier hook'); assert.equal(at(), 'script/queued');   // request changes
  await tickUntilIdle(); assert.equal(at(), 'script/awaiting_review');
  m.pipeline.approveStep(v); assert.equal(at(), 'production/queued');
  assert.equal(m.db.getVideo(v).note, null);                                       // feedback does not leak into later steps
  await tickUntilIdle(); assert.equal(at(), 'production/awaiting_review');
  assert.ok(fs.existsSync(path.join(m.paths.videoDir(pid, v), 'production.md')));
  assert.throws(() => m.pipeline.approve(v), /only finished videos/);

  // Switching reviews off releases the waiting video, and it then runs straight to the final approval.
  m.db.run('UPDATE projects SET review_steps=0 WHERE id=?', pid);
  m.pipeline.releaseReviews(pid); assert.equal(at(), 'produce/queued');
  await tickUntilIdle(); await tickUntilIdle(); assert.equal(at(), 'approval/awaiting_approval');

  // Production off: script goes straight to the film.
  m.db.run('UPDATE projects SET production_step=0 WHERE id=?', pid);
  const w = m.pipeline.createVideo(pid).id as number;
  await tickUntilIdle(); await tickUntilIdle();
  assert.equal(m.db.getVideo(w).stage, 'produce');
  m.db.setSetting('mock_mode', false);
});

test('archive keeps a video aside and restore brings it back', async () => {
  const pid = Number(m.db.run(`INSERT INTO projects(name, niche, created_at) VALUES ('A','x',?)`, new Date().toISOString()).lastInsertRowid);
  const v = await makeFinishedVideo(pid);
  m.pipeline.approve(v);                                        // ready_to_publish (no channel)
  m.pipeline.archive(v);
  let x = m.db.getVideo(v);
  assert.equal(x.status, 'archived'); assert.equal(x.scheduled_at, null);
  assert.throws(() => m.pipeline.approve(v), /only finished videos/);
  m.pipeline.unarchive(v);
  x = m.db.getVideo(v);
  assert.equal(`${x.stage}/${x.status}`, 'approval/awaiting_approval');

  const w = m.pipeline.createVideo(pid).id as number;           // unfinished: comes back to its step
  m.db.updateVideo(w, { stage: 'script', status: 'awaiting_review' });
  m.pipeline.archive(w); m.pipeline.unarchive(w);
  assert.equal(m.db.getVideo(w).status, 'awaiting_review');
  m.db.updateVideo(w, { status: 'rejected' });
});

test('past performance is briefed to Claude only once there is enough data', async () => {
  const { performance, performanceText } = await import('../src/insights.ts');
  const pid = Number(m.db.run(`INSERT INTO projects(name, niche, created_at) VALUES ('P','x',?)`, new Date().toISOString()).lastInsertRowid);
  const ch = Number(m.db.run(`INSERT INTO channels(platform, external_id, name, tokens, status, created_at) VALUES ('youtube','perf','Perf','x','connected',?)`, new Date().toISOString()).lastInsertRowid);
  const old = new Date(Date.now() - 3 * 86400_000).toISOString();
  const add = (title: string, views: number, at = old) => {
    const v = m.pipeline.createVideo(pid).id as number;
    m.db.updateVideo(v, { title, stage: 'done', status: 'published' });
    fs.writeFileSync(path.join(m.paths.videoDir(pid, v), 'metadata.json'), JSON.stringify({ title, style: 'ink', hook: `Hook of ${title}` }));
    const post = Number(m.db.run(`INSERT INTO posts(video_id, channel_id, platform, status, scheduled_at, published_at) VALUES (?,?,'youtube','published',?,?)`, v, ch, at, at).lastInsertRowid);
    m.db.run(`INSERT INTO stats(post_id, date, views, likes, comments) VALUES (?,?,?,?,0)`, post, '2026-11-01', 1, 0);
    m.db.run(`INSERT INTO stats(post_id, date, views, likes, comments) VALUES (?,?,?,?,0)`, post, '2026-11-02', views, Math.round(views / 10));
  };
  ['A', 'B', 'C', 'D'].forEach((t, i) => add(t, (i + 1) * 100));
  assert.equal(performanceText(pid), '');                               // 4 videos: not enough yet
  add('E', 900); add('Fresh', 5000, new Date().toISOString());          // today's video is too new to count
  const list = performance(pid);
  assert.deepEqual(list.map((x: any) => x.title), ['E', 'D', 'C', 'B', 'A']);
  assert.equal(list[0].views, 900);                                     // latest snapshot, not the sum of days
  const text = performanceText(pid);
  assert.match(text, /Best performers:\n- "E" — 900 views/); assert.match(text, /Weakest performers:\n- "B"/); assert.match(text, /hook: "Hook of E"/);
});

test('usage is added up from a step log, across several Claude runs', async () => {
  const { usageOf } = await import('../src/usage.ts');
  const f = path.join(tmp, 'usage.jsonl');
  const result = (cost: number, model: string) => JSON.stringify({ type: 'result', total_cost_usd: cost, num_turns: 5,
    usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 1000, output_tokens: 50 }, modelUsage: { [model]: { costUSD: cost } } });
  fs.writeFileSync(f, ['{"type":"assistant"}', result(0.4, 'claude-sonnet-5-5'), 'not json', result(0.05, 'claude-haiku-5-5')].join('\n'));
  assert.deepEqual(usageOf(f), { cost_usd: 0.45, turns: 10, tokens_new: 200, tokens_cached: 2000, tokens_out: 100, model: 'sonnet-5-5' });
  assert.equal(usageOf(path.join(tmp, 'missing.jsonl')), null);
});

test('S3 storage: upload deliverables once, links, restore, delete and database backup', async () => {
  // A minimal S3 stand-in: path-style PUT/GET/DELETE and ListObjectsV2, refusing unsigned requests.
  const objects = new Map<string, Buffer>();
  let unsigned = 0;
  const s3 = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const signed = /^AWS4-HMAC-SHA256 /.test(req.headers.authorization || '') || u.searchParams.has('X-Amz-Signature');
    if (!signed) { unsigned++; res.writeHead(403).end('<Error><Code>AccessDenied</Code><Message>unsigned</Message></Error>'); return; }
    const [, bucket, ...rest] = decodeURIComponent(u.pathname).split('/'); const key = rest.join('/');
    if (bucket !== 'bkt') { res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>'); return; }
    if (req.method === 'PUT') { const chunks: Buffer[] = []; req.on('data', (d) => chunks.push(d)); req.on('end', () => { objects.set(key, Buffer.concat(chunks)); res.writeHead(200).end(); }); return; }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return; }
    if (!key) {
      const prefix = u.searchParams.get('prefix') || '';
      const items = [...objects].filter(([k]) => k.startsWith(prefix)).map(([k, b]) => `<Contents><Key>${k}</Key><LastModified>x</LastModified><Size>${b.length}</Size></Contents>`).join('');
      res.writeHead(200).end(`<ListBucketResult>${items}</ListBucketResult>`); return;
    }
    const b = objects.get(key);
    if (!b) { res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'); return; }
    res.writeHead(200).end(b);
  });
  await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
  const st = await import('../src/storage.ts');
  try {
    assert.equal(st.s3Configured(), false);
    for (const [k, v] of Object.entries({ s3_bucket: 'bkt', s3_endpoint: `http://127.0.0.1:${(s3.address() as any).port}`, s3_access_key_id: 'AKIATEST', s3_secret_access_key: 'secret', s3_prefix: 'va' })) m.db.setSetting(k, v);
    assert.match(await st.testS3(), /Connected to bucket/);

    const pid = Number(m.db.run(`INSERT INTO projects(name, niche, created_at) VALUES ('S3','x',?)`, new Date().toISOString()).lastInsertRowid);
    const v = await makeFinishedVideo(pid);
    const dir = m.paths.videoDir(pid, v);
    fs.mkdirSync(path.join(dir, 'film')); fs.writeFileSync(path.join(dir, 'film', 'scratch.txt'), 'work');
    assert.equal(await st.syncVideo(v), 2);                                   // final.mp4 + metadata.json; the film folder stays local
    assert.equal(await st.syncVideo(v), 0);                                   // unchanged files are not sent again
    const base = `va/projects/p${pid}/v${v}/`;
    assert.deepEqual([...objects.keys()].filter((k) => k.startsWith(base)).sort(), [`${base}final.mp4`, `${base}metadata.json`]);

    const link = await st.videoFileLink(v, 'final.mp4');
    assert.match(link, /X-Amz-Signature=/);
    const got = await fetch(link); assert.equal(got.status, 200);
    assert.equal((await got.arrayBuffer()).byteLength, fs.statSync(path.join(dir, 'final.mp4')).size);

    fs.rmSync(path.join(dir, 'metadata.json'));                               // lost locally → restored from S3
    assert.match((await st.missingFileLink(v, 'metadata.json'))!, /metadata\.json\?/);
    assert.equal(await st.missingFileLink(v, 'film/scratch.txt'), null);
    assert.deepEqual(await st.restoreAll(), { files: 1 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')).title, 'Why Mars is red');

    assert.match(await st.backupDatabase(), /^backups\/app-\d{4}-\d\d-\d\d\.db$/);
    assert.ok(objects.get('va/backups/app-latest.db')!.subarray(0, 15).toString() === 'SQLite format 3');

    await st.deleteVideoFiles(pid, v);
    assert.equal([...objects.keys()].filter((k) => k.startsWith(base)).length, 0);
    assert.equal(unsigned, 0);
  } finally {
    for (const k of ['s3_bucket', 's3_endpoint', 's3_access_key_id', 's3_secret_access_key', 's3_prefix']) m.db.setSetting(k, '');
    s3.close();
  }
});

test('sign-in: open until a password is set, then admin password and allowed Google accounts only', async () => {
  const { Hono } = await import('hono');
  const { api } = await import('../src/api.ts');
  const { guard, clearAdminPassword } = await import('../src/auth.ts');
  const app = new Hono(); app.use('/api/*', guard); app.use('/files/*', guard); app.route('/api', api);
  const call = (p: string, o: { method?: string; json?: unknown; cookie?: string; origin?: string } = {}) => app.request(p, {
    method: o.method ?? (o.json !== undefined ? 'POST' : 'GET'), body: o.json !== undefined ? JSON.stringify(o.json) : undefined,
    headers: { ...(o.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.origin ? { origin: o.origin } : {}), host: 'localhost:4317' },
  });
  const cookieOf = (r: Response, name = 'va_session') => (r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0];
  try {
    // Open while no password exists.
    assert.equal((await call('/api/overview')).status, 200);
    assert.deepEqual(await (await call('/api/auth/me')).json(), { required: false, user: { email: 'local', role: 'admin' }, google: false });
    assert.equal((await call('/api/auth/access', { method: 'PUT', json: { password: 'short' } })).status, 400);
    assert.equal((await call('/api/auth/access', { method: 'PUT', json: { emails: ['a@b.co'] } })).status, 400);   // needs a password first

    // Setting the password locks the app and keeps the setter signed in.
    const set = await call('/api/auth/access', { method: 'PUT', json: { password: 'correct horse battery' } });
    assert.equal(set.status, 200);
    const admin = cookieOf(set); assert.ok(admin.length > 30);
    assert.match(set.headers.getSetCookie().join(';'), /HttpOnly/);
    assert.equal((await call('/api/overview')).status, 401);
    assert.equal((await call('/files/1/final.mp4')).status, 401);
    assert.equal((await call('/api/overview', { cookie: 'va_session=forged' })).status, 401);
    assert.equal((await call('/api/overview', { cookie: admin })).status, 200);

    // Password sign-in, and lock-out after repeated wrong tries.
    assert.equal((await call('/api/auth/login', { json: { password: 'nope' } })).status, 401);
    const login = await call('/api/auth/login', { json: { password: 'correct horse battery' } });
    assert.equal(login.status, 200); assert.ok(cookieOf(login));
    for (let i = 0; i < 5; i++) await call('/api/auth/login', { json: { password: 'nope' } });
    assert.equal((await call('/api/auth/login', { json: { password: 'correct horse battery' } })).status, 429);

    // A change sent from another site is refused even with a valid session.
    assert.equal((await call('/api/settings', { method: 'PUT', json: { paused: false }, cookie: admin, origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('/api/settings', { method: 'PUT', json: { paused: false }, cookie: admin, origin: 'http://localhost:4317' })).status, 200);

    // Google sign-in: only allowed, verified emails get in, as members.
    assert.equal((await call('/api/auth/access', { method: 'PUT', json: { emails: ['Friend@Example.com'] }, cookie: admin })).status, 200);
    assert.equal((await (await call('/api/auth/me')).json()).google, true);
    const viaGoogle = async (email: string) => {
      fakeLoginEmail = email;
      const start = await call('/api/auth/google/start');
      const to = new URL(start.headers.get('location')!);
      assert.equal(to.searchParams.get('scope'), 'openid email');
      assert.match(to.searchParams.get('redirect_uri')!, /\/api\/auth\/google\/callback$/);
      return call(`/api/auth/google/callback?code=abc&state=${to.searchParams.get('state')}`, { cookie: cookieOf(start, 'va_login_state') });
    };
    const stranger = await viaGoogle('stranger@example.com');
    assert.match(decodeURIComponent(stranger.headers.get('location')!), /^\/login\?error=stranger@example\.com is not allowed/);
    assert.equal(cookieOf(stranger), '');
    const forged = await call('/api/auth/google/callback?code=abc&state=whatever');
    assert.match(decodeURIComponent(forged.headers.get('location')!), /Sign-in expired/);
    const friend = await viaGoogle('friend@example.com');
    assert.equal(friend.headers.get('location'), '/');
    const member = cookieOf(friend);
    assert.deepEqual((await (await call('/api/auth/me', { cookie: member })).json()).user, { email: 'friend@example.com', role: 'member' });

    // Members work with videos but cannot touch settings, keys, storage or access.
    assert.equal((await call('/api/videos', { cookie: member })).status, 200);
    assert.equal((await call('/api/settings', { method: 'PUT', json: { paused: false }, cookie: member })).status, 200);
    assert.equal((await call('/api/settings', { method: 'PUT', json: { youtube_client_secret: 'x' }, cookie: member })).status, 403);
    assert.equal((await call('/api/auth/access', { cookie: member })).status, 403);
    assert.equal((await call('/api/storage/test', { method: 'POST', cookie: member })).status, 403);
    assert.equal((await call('/api/oauth/youtube/start', { cookie: member })).status, 403);

    // Removing the email ends that person's access at once; signing out ends a session.
    await call('/api/auth/access', { method: 'PUT', json: { emails: [] }, cookie: admin });
    assert.equal((await call('/api/videos', { cookie: member })).status, 401);
    await call('/api/auth/logout', { method: 'POST', cookie: admin });
    assert.equal((await call('/api/overview', { cookie: admin })).status, 401);
  } finally { clearAdminPassword(); m.db.setSetting('login_emails', []); }
  assert.equal((await call('/api/overview')).status, 200);
});

// ─── Learning loop ───────────────────────────────────────────────────────────
function publishedVideo(pid: number, title: string, views: number, daysAgo: number, extra: Record<string, unknown> = {}) {
  const v = m.pipeline.createVideo(pid).id as number;
  m.db.updateVideo(v, { title, stage: 'done', status: 'published' });
  fs.writeFileSync(path.join(m.paths.videoDir(pid, v), 'metadata.json'), JSON.stringify({ title, style: 'ink', hook: `Hook of ${title}`, tags: { timeliness: 'timely' } }));
  const ch = m.db.get(`SELECT id FROM channels WHERE platform='youtube' LIMIT 1`)?.id
    ?? Number(m.db.run(`INSERT INTO channels(platform, external_id, name, tokens, status, created_at) VALUES ('youtube','learn','L','x','connected',?)`, new Date().toISOString()).lastInsertRowid);
  const at = new Date(Date.now() - daysAgo * 86400_000).toISOString();
  const post = Number(m.db.run(`INSERT INTO posts(video_id, channel_id, platform, status, scheduled_at, published_at, external_id) VALUES (?,?,'youtube','published',?,?,?)`, v, ch, at, at, `ext${v}`).lastInsertRowid);
  m.db.run(`INSERT INTO metrics(post_id, checkpoint, taken_at, data) VALUES (?,?,?,?)`, post, '24h', new Date().toISOString(), JSON.stringify({ views, avg_view_pct: 40, ...extra }));
  m.db.run(`INSERT INTO metrics(post_id, checkpoint, taken_at, data) VALUES (?,?,?,?)`, post, 'latest', new Date().toISOString(), JSON.stringify({ views, avg_view_pct: 40, ...extra }));
  return v;
}

test('stats: watch time, retention and comments are frozen at the 24h / 3d / 7d checkpoints', async () => {
  const pid = Number(m.db.run(`INSERT INTO projects(name, niche, created_at) VALUES ('Stats','x',?)`, new Date().toISOString()).lastInsertRowid);
  const v = m.pipeline.createVideo(pid).id as number;
  m.db.updateVideo(v, { stage: 'done', status: 'published', title: 'Measured' });
  const ch = m.db.get(`SELECT id FROM channels WHERE platform='youtube' AND status='connected' AND external_id='UC123'`).id;
  const at = new Date(Date.now() - 4 * 86400_000).toISOString();     // 4 days old: past 24h and 3d, not 7d
  const post = Number(m.db.run(`INSERT INTO posts(video_id, channel_id, platform, status, scheduled_at, published_at, external_id) VALUES (?,?,'youtube','published',?,?,'ytdeep')`, v, ch, at, at).lastInsertRowid);
  await m.publish.statsTick(true);
  const rows = Object.fromEntries(m.db.all('SELECT checkpoint, data FROM metrics WHERE post_id=?', post).map((r: any) => [r.checkpoint, JSON.parse(r.data)]));
  assert.deepEqual(Object.keys(rows).sort(), ['24h', '3d', 'latest']);
  assert.equal(rows.latest.views, 120); assert.equal(rows.latest.avg_view_pct, 61.5); assert.equal(rows.latest.subs_gained, 3);
  assert.equal(rows['3d'].retention.length, 20); assert.equal(rows['3d'].retention[0], 0.94);
  assert.deepEqual(rows['3d'].comments, ['More of these please', 'Source?']);
  await m.publish.statsTick(true);                                      // checkpoints are frozen, not overwritten
  assert.equal(m.db.all('SELECT * FROM metrics WHERE post_id=?', post).length, 3);
});

test('analyst: playbook, confident tweaks apply, shifts wait for approval, undo, owner edits survive', async () => {
  const L = await import('../src/learning.ts');
  const inbox = await import('../src/inbox.ts');
  m.db.setSetting('mock_mode', true);
  try {
    const pid = Number(m.db.run(`INSERT INTO projects(name, niche, post_times, created_at) VALUES ('Learn','science','["18:00"]',?)`, new Date().toISOString()).lastInsertRowid);
    publishedVideo(pid, 'Algae', 190, 3); publishedVideo(pid, 'Lock', 8, 4);
    assert.equal(L.analysisDue(m.db.getProject(pid)), false);         // 2 published: too early
    publishedVideo(pid, 'Telescope', 20, 1);
    assert.equal(L.analysisDue(m.db.getProject(pid)), true);

    const before = inbox.unreadCount();
    const r = (await L.analyse(pid))!;
    assert.equal(r.applied.length, 1); assert.equal(r.applied[0].level, 'tweak');
    assert.deepEqual(m.db.getProject(pid).post_times, ['19:00']);      // medium-confidence tweak applied by itself
    assert.equal(r.pending.length, 1); assert.equal(r.pending[0].level, 'shift');
    assert.equal(m.db.getProject(pid).focus, '');                     // "ask" mode: shift waits
    assert.equal(inbox.unreadCount() - before, 3);                    // playbook + applied + proposal
    assert.match(L.playbookText(pid), /Lean towards topics like “Algae”/);
    assert.equal(L.analysisDue(m.db.getProject(pid)), false);         // just analysed

    L.applyProposal(r.pending[0].id);
    assert.equal(m.db.getProject(pid).focus, 'Discoveries in the news this month');
    assert.deepEqual(L.approvalStats(pid), { approved: 1, dismissed: 0 });
    L.undoProposal(r.pending[0].id);
    assert.equal(m.db.getProject(pid).focus, '');
    assert.throws(() => L.applyProposal(r.pending[0].id), /already undone/);

    // Owner strikes a lesson and pins one; a new analysis keeps both decisions.
    L.setLessonStatus(pid, 'L1', 'struck');
    const pb = L.readPlaybook(pid)!; pb.lessons.push({ id: 'L9', text: 'Always cite a source on screen', status: 'pinned' });
    fs.writeFileSync(path.join(L.learningDir(pid), 'playbook.json'), JSON.stringify(pb));
    m.db.run('UPDATE projects SET analyzed_at=NULL, adapt_mode=? WHERE id=?', 'auto', pid);
    const r2 = (await L.analyse(pid))!;
    const again = L.readPlaybook(pid)!;
    assert.equal(again.lessons.find((l: any) => l.id === 'L1')!.status, 'struck');
    assert.equal(again.lessons.find((l: any) => l.id === 'L9')!.status, 'pinned');
    assert.doesNotMatch(L.playbookText(pid), /Lean towards/);
    assert.match(L.playbookText(pid), /Always cite a source on screen \(set by the owner/);
    assert.equal(r2.applied.find((a: any) => a.level === 'shift')?.auto, true);   // "Fully automatic": shift applied
    assert.equal(m.db.getProject(pid).focus, 'Discoveries in the news this month');

    // Proposals outside their level's fields, or with wild values, are refused.
    const p = m.db.getProject(pid);
    assert.throws(() => L.validateChanges('tweak', { niche: 'cooking' }, p), /cannot be changed by a tweak/);
    assert.throws(() => L.validateChanges('tweak', { duration_sec: 400 }, p), /out of range/);
    assert.throws(() => L.validateChanges('tweak', { voice_name: 'nobody' }, p), /unknown voice/);
    assert.deepEqual(L.validateChanges('pivot', { niche: 'Space news' }, p), { niche: 'Space news' });
  } finally { m.db.setSetting('mock_mode', false); }
});

test('skill scout: finds are announced, Add pins an exact GitHub version, and the skill becomes a style', async () => {
  const S = await import('../src/skills.ts');
  const inbox = await import('../src/inbox.ts');
  m.db.setSetting('mock_mode', true);
  try {
    const r = await S.runScout();
    assert.equal(r.found, 1);
    const found = S.listSkills().find((s: any) => s.slug === 'demo-video-skill')!;
    assert.equal(found.status, 'found'); assert.equal(found.repo, 'https://github.com/example/video-skill');
    assert.match(inbox.listNotes(5).map((n: any) => n.title).join('|'), /New visual skill found: Demo video skill/);
    assert.equal((await S.runScout()).found, 0);                      // known finds are not announced twice

    const installed = await S.installSkill(found.id);
    const ipath = installed.path!;
    assert.equal(installed.status, 'installed'); assert.equal(installed.ref, FAKE_SHA);
    assert.ok(ipath.endsWith(`demo-video-skill@${FAKE_SHA.slice(0, 7)}`));
    assert.equal(fs.readFileSync(path.join(ipath, 'SKILL.md'), 'utf8'), '# Demo skill\n');
    assert.ok(!fs.existsSync(path.join(ipath, '..', 'README.md')));   // only the skill folder is kept

    assert.ok(S.skillStyles().some((s: any) => s.slug === 'skill:demo-video-skill' && s.category === 'Other skills'));
    assert.match(S.styleInfo('skill:demo-video-skill').rules, /SKILL\.md/);
    assert.match(S.skillStyleText([]), /skill:demo-video-skill/);

    const pid = Number(m.db.run(`INSERT INTO projects(name, niche, styles, created_at) VALUES ('Sk','x','["skill:demo-video-skill"]',?)`, new Date().toISOString()).lastInsertRowid);
    S.trySkill(found.id, pid);
    assert.equal(m.db.getProject(pid).next_style, 'skill:demo-video-skill');
    S.removeSkill(found.id);
    assert.ok(!fs.existsSync(ipath));
    assert.deepEqual(m.db.getProject(pid).styles, []); assert.equal(m.db.getProject(pid).next_style, null);

    assert.throws(() => S.parseRepo('https://evil.example/x/y'), /Only public GitHub/);
    assert.throws(() => S.parseRepo('https://github.com/../etc'), /Only public GitHub/);
  } finally { m.db.setSetting('mock_mode', false); }
});
