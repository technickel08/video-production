import crypto from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, get, run, now, getSetting, setSetting } from './db.ts';
import { BASE_URL } from './paths.ts';

/**
 * Sign-in for the dashboard.
 *  - Admin: the master password. Can do everything, including settings, keys and access.
 *  - Member: a Google account whose email the admin has allowed. Can run the pipeline, review and publish.
 * Sign-in is required as soon as an admin password exists. Without one the app is open, and it then only
 * listens on this machine (see index.ts).
 */
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
)`);

export type Role = 'admin' | 'member';
export interface User { email: string; role: Role }

const COOKIE = 'va_session';
const SESSION_DAYS = 30;
const secure = () => BASE_URL.startsWith('https://');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// ─── Admin password ──────────────────────────────────────────────────────────
function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw: string, stored: string) {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64); const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const MIN_PASSWORD = 10;
export function setAdminPassword(pw: string) {
  if (pw.length < MIN_PASSWORD) throw new Error(`The admin password needs at least ${MIN_PASSWORD} characters`);
  setSetting('admin_password_hash', hashPassword(pw));
}
/** Turns sign-in off again and signs everyone out. */
export function clearAdminPassword() { setSetting('admin_password_hash', ''); run('DELETE FROM sessions'); }
export const authRequired = () => !!getSetting('admin_password_hash', '');

/** ADMIN_PASSWORD in the environment sets (or resets) the admin password at start-up. */
export function applyEnvPassword() {
  const pw = process.env.ADMIN_PASSWORD;
  if (pw && !verifyPassword(pw, getSetting('admin_password_hash', ''))) setAdminPassword(pw);
}

// ─── Google sign-in ──────────────────────────────────────────────────────────
const emails = () => getSetting<string[]>('login_emails', []);
const googleCreds = () => ({
  id: getSetting('google_login_client_id', '') || getSetting('youtube_client_id', ''),
  secret: getSetting('google_login_client_secret', '') || getSetting('youtube_client_secret', ''),
});
export const googleEnabled = () => authRequired() && emails().length > 0 && !!googleCreds().id && !!googleCreds().secret;
export const googleRedirectUri = () => `${getSetting('oauth_base_url', BASE_URL)}/api/auth/google/callback`;
const G_AUTH = () => process.env.YT_AUTH_BASE || 'https://accounts.google.com';
const G_TOKEN = () => `${process.env.YT_OAUTH_BASE || 'https://oauth2.googleapis.com'}/token`;
const G_USERINFO = () => process.env.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo';

// ─── Sessions ────────────────────────────────────────────────────────────────
function startSession(c: Context, user: User) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  run('DELETE FROM sessions WHERE expires_at<?', now());
  run('INSERT INTO sessions(token_hash, email, role, created_at, expires_at) VALUES (?,?,?,?,?)', sha(token), user.email, user.role, now(), expires.toISOString());
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: secure(), path: '/', expires });
}
function sessionUser(c: Context): User | null {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const s = get<{ email: string; role: Role }>('SELECT email, role FROM sessions WHERE token_hash=? AND expires_at>?', sha(token), now());
  if (!s) return null;
  // An allowed email that the admin has since removed loses access straight away.
  if (s.role === 'member' && !emails().includes(s.email)) return null;
  return s;
}
export const currentUser = (c: Context): User => (c.get('user' as never) as User | undefined) ?? { email: 'local', role: 'admin' };

/** Routes only the admin may use (settings writes are checked in their own handler). */
const ADMIN_ONLY: [string, RegExp][] = [
  ['*', /^\/api\/storage\//], ['*', /^\/api\/install-tools/], ['GET', /^\/api\/oauth\/[^/]+\/start/],
  ['DELETE', /^\/api\/channels\//], ['DELETE', /^\/api\/projects\//], ['*', /^\/api\/auth\/access/],
];

/** Guards /api and /files. */
export const guard: MiddlewareHandler = async (c, next) => {
  if (!authRequired()) return next();
  const p = c.req.path; const method = c.req.method;
  if (/^\/api\/auth\/(me|login|logout|google\/)/.test(p)) return next();
  const user = sessionUser(c);
  if (!user) return c.json({ error: 'Sign in required' }, 401);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    // Changes must come from this site, not from a form on another one.
    const origin = c.req.header('origin');
    if (origin) {
      const host = new URL(origin).host;
      const ok = [c.req.header('host'), c.req.header('x-forwarded-host'), new URL(BASE_URL).host].includes(host);
      if (!ok) return c.json({ error: 'Request came from another site' }, 403);
    }
  }
  if (user.role !== 'admin' && ADMIN_ONLY.some(([m, re]) => (m === '*' || m === method) && re.test(p))) return c.json({ error: 'Only the admin can do this' }, 403);
  c.set('user' as never, user as never);
  return next();
};

// ─── Too many wrong passwords ────────────────────────────────────────────────
const fails = new Map<string, { n: number; until: number }>();
const clientKey = (c: Context) => (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'direct';
function locked(key: string) { const f = fails.get(key); return !!f && f.n >= 5 && f.until > Date.now(); }
function failed(key: string) {
  const f = fails.get(key); const fresh = !f || f.until < Date.now();
  fails.set(key, { n: fresh ? 1 : f!.n + 1, until: Date.now() + 15 * 60_000 });
}

// ─── Routes (mounted at /api/auth) ───────────────────────────────────────────
export const auth = new Hono();

auth.get('/me', (c) => c.json({ required: authRequired(), user: authRequired() ? sessionUser(c) : { email: 'local', role: 'admin' }, google: googleEnabled() }));

auth.post('/login', async (c) => {
  const key = clientKey(c);
  if (locked(key)) return c.json({ error: 'Too many wrong passwords. Try again in 15 minutes.' }, 429);
  const { password } = await c.req.json().catch(() => ({}));
  if (!authRequired() || typeof password !== 'string' || !verifyPassword(password, getSetting('admin_password_hash', ''))) {
    failed(key);
    await new Promise((r) => setTimeout(r, 400));
    return c.json({ error: 'Wrong password' }, 401);
  }
  fails.delete(key);
  startSession(c, { email: 'admin', role: 'admin' });
  return c.json({ ok: true });
});

auth.post('/logout', (c) => {
  const token = getCookie(c, COOKIE);
  if (token) run('DELETE FROM sessions WHERE token_hash=?', sha(token));
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

const STATE = 'va_login_state';
auth.get('/google/start', (c) => {
  if (!googleEnabled()) return c.redirect('/login?error=' + encodeURIComponent('Google sign-in is not set up'));
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(c, STATE, state, { httpOnly: true, sameSite: 'Lax', secure: secure(), path: '/', maxAge: 600 });
  const q = new URLSearchParams({ client_id: googleCreds().id, redirect_uri: googleRedirectUri(), response_type: 'code', scope: 'openid email', state, prompt: 'select_account' });
  return c.redirect(`${G_AUTH()}/o/oauth2/v2/auth?${q}`);
});

auth.get('/google/callback', async (c) => {
  const back = (msg: string) => c.redirect('/login?error=' + encodeURIComponent(msg));
  const state = getCookie(c, STATE); deleteCookie(c, STATE, { path: '/' });
  if (!googleEnabled()) return back('Google sign-in is not set up');
  if (!state || state !== c.req.query('state')) return back('Sign-in expired. Please try again.');
  const code = c.req.query('code');
  if (!code) return back(c.req.query('error') === 'access_denied' ? 'Sign-in was cancelled' : 'Google did not return a sign-in code');
  try {
    const t: any = await fetch(G_TOKEN(), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: googleCreds().id, client_secret: googleCreds().secret, redirect_uri: googleRedirectUri(), grant_type: 'authorization_code' }),
    }).then((r) => r.json());
    if (!t.access_token) return back(`Google sign-in failed: ${t.error_description || t.error || 'no token'}`);
    const info: any = await fetch(G_USERINFO(), { headers: { authorization: `Bearer ${t.access_token}` } }).then((r) => r.json());
    const email = String(info.email || '').toLowerCase();
    if (!email || info.email_verified === false || info.email_verified === 'false') return back('Google did not confirm an email address for this account');
    if (!emails().includes(email)) { console.error(`[login] refused ${email}: not on the allowed list`); return back(`${email} is not allowed to use this dashboard. Ask the admin to add it.`); }
    startSession(c, { email, role: 'member' });
    return c.redirect('/');
  } catch (e: any) { return back(`Google sign-in failed: ${e.message}`); }
});

// Access settings — admin only (enforced by the guard once a password exists).
auth.get('/access', (c) => c.json({
  hasPassword: authRequired(), emails: emails(), redirectUri: googleRedirectUri(),
  googleClientId: getSetting('google_login_client_id', ''), googleSecretSet: !!getSetting('google_login_client_secret', ''),
  usesYoutubeKeys: !getSetting('google_login_client_id', '') && !!getSetting('youtube_client_id', ''), googleReady: googleEnabled(),
}));

auth.put('/access', async (c) => {
  const b = await c.req.json();
  if (typeof b.password === 'string' && b.password) {
    const first = !authRequired();
    setAdminPassword(b.password);
    run(`DELETE FROM sessions WHERE role='admin'`);          // other admin sessions end when the password changes
    startSession(c, { email: 'admin', role: 'admin' });      // …but whoever set it stays signed in
    if (first) console.log('[login] admin password set — sign-in is now required');
  }
  if (Array.isArray(b.emails)) {
    const list = [...new Set(b.emails.map((e: unknown) => String(e).trim().toLowerCase()).filter(Boolean))] as string[];
    const bad = list.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad) throw new Error(`“${bad}” is not an email address`);
    if (list.length && !authRequired()) throw new Error('Set an admin password first; Google sign-in is added on top of it.');
    setSetting('login_emails', list);
    run(`DELETE FROM sessions WHERE role='member' AND email NOT IN (${list.map(() => '?').join(',') || "''"})`, ...list);
  }
  if (typeof b.googleClientId === 'string') setSetting('google_login_client_id', b.googleClientId.trim());
  if (typeof b.googleClientSecret === 'string' && b.googleClientSecret !== '••••••••') setSetting('google_login_client_secret', b.googleClientSecret.trim());
  return c.json({ ok: true });
});
