import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle, Copy, ChevronDown } from 'lucide-react';
import { useData } from '../live';
import { api, post, put } from '../api';
import { Button, PageHeader, Section, Toggle, useAction, toast } from '../ui';

interface Check { id: string; label: string; ok: boolean; detail: string; fix?: string; needed: string; }

export default function Settings() {
  const { data: h } = useData<{ checks: Check[]; install: { log: string[]; done: boolean; ok?: boolean } | null }>('/health');
  const [s, setS] = useState<Record<string, any> | null>(null);
  const { busy, run } = useAction();
  const origin = window.location.origin.replace(':5173', ':4317');

  useEffect(() => { api('/settings').then(setS); }, []);
  useEffect(() => { if (window.location.hash) document.querySelector(window.location.hash)?.scrollIntoView(); }, [s]);
  if (!s) return null;
  const save = (patch: Record<string, any>, msg = 'Saved') => run('save', async () => { await put('/settings', patch); setS({ ...s, ...patch }); toast(msg); });

  return (
    <>
      <PageHeader title="Settings" subtitle="Setup checks, automation and platform connections." />
      <div className="space-y-4">
        <Section title="Setup checks" description="What this machine needs. Each line says which part of the system depends on it."
          actions={<div className="flex gap-2">
            <Button size="sm" loading={busy === 'claude'} onClick={() => run('claude', async () => { const r = await post('/health/claude-test'); toast(r.ok ? 'Claude is working' : r.detail, r.ok ? 'ok' : 'error'); })}>Test Claude</Button>
            <Button size="sm" variant="primary" loading={!!h?.install && !h.install.done} onClick={() => run('install', () => post('/health/install-tools'))}>Install video tools</Button>
          </div>}>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {h?.checks.map((c) => (
              <div key={c.id} className="flex items-start gap-3 py-2.5">
                {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2"><span className="text-sm font-medium">{c.label}</span><span className="text-xs text-zinc-400">for {c.needed}</span></div>
                  <div className="break-all text-xs text-zinc-500">{c.detail}</div>
                  {!c.ok && c.fix && <Fix text={c.fix} />}
                </div>
              </div>
            ))}
          </div>
          {h?.install && <InstallLog log={h.install.log} />}
        </Section>

        <Section title="Automation">
          <Toggle checked={!!s.paused} onChange={(v) => save({ paused: v }, v ? 'Automation paused' : 'Automation resumed')} label="Pause everything" hint="Stops starting new steps and publishing. Running steps finish." />
          <Toggle checked={!!s.mock_mode} onChange={(v) => save({ mock_mode: v })} label="Test mode" hint="Run the whole pipeline with sample files and a test-pattern video, without using Claude. Good for trying the dashboard." />
          <Toggle checked={s.scout_enabled !== false} onChange={(v) => save({ scout_enabled: v })} label="Skill scout"
            hint={`Every ${s.scout_every_days ?? 14} days, search the web for better video skills and tell you about them in What's new. Nothing is added without your click.`} />
          <Toggle checked={s.notifications !== false} onChange={(v) => save({ notifications: v })} label="Mac notifications" hint="When a video needs approval, is published, or fails." />
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div><label className="label">Claude model</label>
              <select className="input" value={s.claude_model ?? ''} onChange={(e) => save({ claude_model: e.target.value })}>
                <option value="">Default (your plan's default)</option><option value="sonnet">Sonnet — balanced</option><option value="opus">Opus — best quality, uses more of your limit</option><option value="haiku">Haiku — fastest, lightest</option>
              </select></div>
            <div className="sm:col-span-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div><div className="text-sm font-medium">Model for each step</div>
                  <div className="text-xs text-zinc-500">The Video step uses 75–90% of a run, so a lighter model there saves the most. Script and Production are short, so a stronger model there costs little.</div></div>
                <Button size="sm" onClick={() => save({ model_research: 'sonnet', model_script: 'opus', model_production: 'opus', model_produce: 'sonnet', model_check: 'sonnet', model_analyst: 'sonnet', model_scout: 'opus' }, 'Recommended models set')}>Use recommended</Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                {([['research', 'Research'], ['script', 'Script'], ['production', 'Production'], ['produce', 'Video'], ['check', 'Check'], ['analyst', 'Analyst'], ['scout', 'Skill scout']] as const).map(([k, label]) => (
                  <div key={k}><label className="label">{label}</label>
                    <select className="input" value={s[`model_${k}`] ?? ''} onChange={(e) => save({ [`model_${k}`]: e.target.value })}>
                      <option value="">{k === 'scout' ? 'Opus (default)' : 'Same as above'}</option><option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option>
                    </select></div>
                ))}
              </div>
            </div>
            <div><label className="label">Max time per video render (minutes)</label>
              <input type="number" min={20} max={600} className="input" defaultValue={s.produce_timeout_min ?? 180} onBlur={(e) => save({ produce_timeout_min: Number(e.target.value) })} /></div>
            <div className="sm:col-span-2"><label className="label">Claude Code path (optional — found automatically)</label>
              <input className="input" defaultValue={s.claude_path ?? ''} placeholder="/path/to/claude" onBlur={(e) => e.target.value !== (s.claude_path ?? '') && save({ claude_path: e.target.value })} /></div>
          </div>
        </Section>

        <div id="connections" className="space-y-4">
          <KeySection title="YouTube connection" fields={[['youtube_client_id', 'OAuth client ID'], ['youtube_client_secret', 'OAuth client secret']]} s={s} onSave={save}
            steps={[
              <>Open <a className="text-accent-600 underline" href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud Console</a> and create a project (any name).</>,
              <>In <b>APIs & Services → Library</b>, enable <b>YouTube Data API v3</b>.</>,
              <>In <b>Google Auth Platform → Branding/Audience</b>, set it up as <b>External</b> and add your Google account under <b>Test users</b>.</>,
              <>In <b>Clients</b>, create an OAuth client of type <b>Web application</b> with this redirect URI: <Copyable text={`${origin}/api/oauth/youtube/callback`} /></>,
              <>Paste the client ID and secret here, save, then go to <b>Channels → Connect YouTube</b>.</>,
              <>Videos uploaded through the API stay <b>private</b> until Google audits your app. Request the audit early: <a className="text-accent-600 underline" href="https://support.google.com/youtube/contact/yt_api_form" target="_blank" rel="noreferrer">YouTube API audit form</a>.</>,
            ]} />
          <KeySection title="Instagram connection" fields={[['meta_app_id', 'Meta app ID'], ['meta_app_secret', 'Meta app secret']]} s={s} onSave={save}
            steps={[
              <>In the Instagram app, switch to a <b>Professional</b> (Business or Creator) account and link it to a <b>Facebook Page</b>.</>,
              <>Sign in at <a className="text-accent-600 underline" href="https://www.facebook.com/login" target="_blank" rel="noreferrer">facebook.com</a> with the account that manages that Page. Meta shows “Page not found” on its developer pages when you are signed out.</>,
              <>Open <a className="text-accent-600 underline" href="https://developers.facebook.com/async/registration" target="_blank" rel="noreferrer">developer registration</a> and finish it once (accept the terms, verify phone or email). Skip this if you already have a developer account.</>,
              <>Go to <a className="text-accent-600 underline" href="https://developers.facebook.com/apps/creation/" target="_blank" rel="noreferrer">Create app</a>. Choose use case <b>Other</b>, then type <b>Business</b>. In the app dashboard add the products <b>Facebook Login for Business</b> and <b>Instagram</b>.</>,
              <>In <b>Facebook Login for Business → Settings</b>, add this under “Valid OAuth Redirect URIs”: <Copyable text={`${origin}/api/oauth/instagram/callback`} /></>,
              <>Copy the app ID and secret from <b>App settings → Basic</b> into the fields here, save, then <b>Channels → Connect Instagram</b>.</>,
              <>While the app is in development mode it can post to accounts with a role on the app (yours) — that's all this needs.</>,
            ]}
            extra={<div className="mt-4"><label className="label">Public video link base (optional)</label>
              <input className="input" defaultValue={s.public_base_url ?? ''} placeholder="Leave empty to use a temporary Cloudflare link"
                onBlur={(e) => e.target.value !== (s.public_base_url ?? '') && save({ public_base_url: e.target.value })} />
              <p className="mt-1 text-xs text-zinc-500">Instagram downloads each video from a public link. By default a temporary Cloudflare link is opened only while posting, serving only that one file.</p></div>} />
          <StorageSection s={s} onSave={save} />
          <AccessSection />
        </div>
      </div>
    </>
  );
}

function KeySection({ title, fields, s, onSave, steps, extra }: { title: string; fields: [string, string][]; s: Record<string, any>; onSave: (p: Record<string, any>) => void; steps: React.ReactNode[]; extra?: React.ReactNode }) {
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map(([k]) => [k, s[k] ?? ''])));
  const [open, setOpen] = useState(!fields.every(([k]) => s[k]));
  const set = fields.every(([k]) => s[k]);
  return (
    <Section title={title} description={set ? 'Keys saved.' : 'Not set up yet.'}>
      <button onClick={() => setOpen(!open)} className="mb-3 flex items-center gap-1 text-sm font-medium text-accent-600">
        <ChevronDown className={`size-4 transition ${open ? '' : '-rotate-90'}`} />How to get these
      </button>
      {open && <ol className="mb-4 list-decimal space-y-2 pl-5 text-sm text-zinc-600 dark:text-zinc-300">{steps.map((st, i) => <li key={i}>{st}</li>)}</ol>}
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([k, label]) => (
          <div key={k}><label className="label">{label}</label>
            <input className="input font-mono" type={k.includes('secret') ? 'password' : 'text'} value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} autoComplete="off" /></div>
        ))}
      </div>
      <Button className="mt-3" variant="primary" size="sm" onClick={() => onSave(vals)}>Save keys</Button>
      {extra}
    </Section>
  );
}

interface Access { hasPassword: boolean; emails: string[]; redirectUri: string; googleClientId: string; googleSecretSet: boolean; usesYoutubeKeys: boolean; googleReady: boolean }
function AccessSection() {
  const { data: a, reload } = useData<Access>('/auth/access');
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [emails, setEmails] = useState<string | null>(null);
  const [gid, setGid] = useState<string | null>(null); const [gsecret, setGsecret] = useState('');
  const { busy, run } = useAction();
  if (!a) return null;
  const emailText = emails ?? a.emails.join('\n');
  const savePw = () => run('pw', async () => {
    if (pw.length < 10) throw new Error('Use at least 10 characters');
    if (pw !== pw2) throw new Error('The two passwords do not match');
    await put('/auth/access', { password: pw }); setPw(''); setPw2(''); reload();
    toast(a.hasPassword ? 'Admin password changed' : 'Admin password set — sign-in is now required');
  });
  const saveGoogle = () => run('g', async () => {
    await put('/auth/access', { emails: emailText.split(/[\s,;]+/).filter(Boolean), ...(gid !== null ? { googleClientId: gid } : {}), ...(gsecret ? { googleClientSecret: gsecret } : {}) });
    setEmails(null); setGsecret(''); reload(); toast('Google sign-in saved');
  });
  return (
    <Section title="Access" description={a.hasPassword ? `Sign-in is required.${a.googleReady ? ` Google sign-in is on for ${a.emails.length} email(s).` : ''}` : 'Open: anyone who can reach this address can use the dashboard. Set an admin password before putting it on a server.'}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label">{a.hasPassword ? 'New admin password' : 'Admin password'}</label>
          <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 10 characters" /></div>
        <div><label className="label">Repeat it</label>
          <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
      </div>
      <Button className="mt-3" variant="primary" size="sm" disabled={!pw} loading={busy === 'pw'} onClick={savePw}>{a.hasPassword ? 'Change password' : 'Set password and require sign-in'}</Button>
      <p className="mt-2 text-xs text-zinc-500">The admin can do everything, including these settings. Lost it? On the machine itself run <code>npm run admin-password -- 'new-password'</code>.</p>

      <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <div className="text-sm font-medium">Google sign-in for other people</div>
        <p className="mb-3 text-xs text-zinc-500">People on this list can sign in with their Google account. They can make, review and publish videos, but cannot change settings, keys, channels or this list.</p>
        <label className="label">Allowed Google emails (one per line)</label>
        <textarea className="input min-h-20 font-mono" value={emailText} onChange={(e) => setEmails(e.target.value)} placeholder="name@gmail.com" disabled={!a.hasPassword} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><label className="label">Google client ID (optional)</label>
            <input className="input font-mono" value={gid ?? a.googleClientId} onChange={(e) => setGid(e.target.value)} placeholder={a.usesYoutubeKeys ? 'Using your YouTube keys' : 'Not set'} autoComplete="off" /></div>
          <div><label className="label">Google client secret (optional)</label>
            <input className="input font-mono" type="password" value={gsecret} onChange={(e) => setGsecret(e.target.value)} placeholder={a.googleSecretSet ? '••••••••' : a.usesYoutubeKeys ? 'Using your YouTube keys' : 'Not set'} autoComplete="off" /></div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">Leave both empty to reuse the YouTube keys above. Either way, add this to the client's “Authorized redirect URIs” in Google Cloud: <Copyable text={a.redirectUri} /></p>
        <Button className="mt-3" size="sm" disabled={!a.hasPassword} loading={busy === 'g'} onClick={saveGoogle}>Save Google sign-in</Button>
        {!a.hasPassword && <span className="ml-2 text-xs text-zinc-500">Set an admin password first.</span>}
      </div>
    </Section>
  );
}

function StorageSection({ s, onSave }: { s: Record<string, any>; onSave: (p: Record<string, any>, msg?: string) => void }) {
  const fields: [string, string, string][] = [
    ['s3_bucket', 'Bucket name', 'my-video-autopilot'], ['s3_region', 'Region', 'us-east-1'],
    ['s3_access_key_id', 'Access key ID', 'Leave empty on EC2 with an IAM role'], ['s3_secret_access_key', 'Secret access key', 'Leave empty on EC2 with an IAM role'],
    ['s3_prefix', 'Folder in the bucket', 'video-autopilot'], ['s3_endpoint', 'Endpoint (only for non-AWS S3)', 'https://<account>.r2.cloudflarestorage.com'],
  ];
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map(([k]) => [k, s[k] ?? ''])));
  const [open, setOpen] = useState(!s.s3_bucket);
  const { busy, run } = useAction();
  const call = (id: string, path: string, done: (r: any) => string) => run(id, async () => { toast(done(await post(path))); });
  return (
    <Section title="Cloud storage (S3)" description={s.s3_bucket ? `Using bucket “${s.s3_bucket}”.` : 'Not set up — files are kept on this disk only.'}>
      <button onClick={() => setOpen(!open)} className="mb-3 flex items-center gap-1 text-sm font-medium text-accent-600">
        <ChevronDown className={`size-4 transition ${open ? '' : '-rotate-90'}`} />What this does and how to set it up
      </button>
      {open && <ol className="mb-4 list-decimal space-y-2 pl-5 text-sm text-zinc-600 dark:text-zinc-300">
        <li>Each finished step's files (research, script, production plan, final video, poster, captions) are copied to your bucket, and the database is backed up there every 6 hours.</li>
        <li>Instagram downloads videos from a time-limited S3 link, so the temporary Cloudflare tunnel is no longer used.</li>
        <li>Create a <b>private</b> bucket in the AWS S3 console (keep “Block all public access” on).</li>
        <li><b>On EC2:</b> attach an IAM role to the instance that allows <code>s3:PutObject</code>, <code>s3:GetObject</code>, <code>s3:DeleteObject</code> and <code>s3:ListBucket</code> on that bucket, and leave both key fields empty. <b>Elsewhere:</b> create an access key for an IAM user with the same permissions and paste it here.</li>
        <li>Save, then press <b>Test connection</b>.</li>
      </ol>}
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([k, label, ph]) => (
          <div key={k}><label className="label">{label}</label>
            <input className="input font-mono" type={k.includes('secret') ? 'password' : 'text'} placeholder={ph} value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} autoComplete="off" /></div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" onClick={() => onSave(Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, String(v).trim()])))}>Save</Button>
        <Button size="sm" disabled={!s.s3_bucket} loading={busy === 'test'} onClick={() => call('test', '/storage/test', (r) => r.detail)}>Test connection</Button>
        <Button size="sm" disabled={!s.s3_bucket} loading={busy === 'sync'} onClick={() => call('sync', '/storage/sync', (r) => `Uploaded ${r.files} file(s) from ${r.videos} video(s) and backed up the database`)}>Upload everything now</Button>
        <Button size="sm" disabled={!s.s3_bucket} loading={busy === 'restore'} onClick={() => call('restore', '/storage/restore', (r) => `Restored ${r.files} missing file(s) from S3`)}>Restore missing files</Button>
      </div>
      <p className="mt-2 text-xs text-zinc-500">The working film folder and step logs stay on this disk. The file that encrypts your channel sign-ins (<code>data/secret.key</code>) is never uploaded.</p>
    </Section>
  );
}

function Copyable({ text }: { text: string }) {
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); toast('Copied'); }}
      className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-lg bg-zinc-100 px-2 py-1 font-mono text-xs dark:bg-zinc-800">
      <span className="truncate">{text}</span><Copy className="size-3 shrink-0" />
    </button>
  );
}

function Fix({ text }: { text: string }) {
  const cmd = /^(npm|brew|claude)\s/.test(text);
  return cmd ? <Copyable text={text} /> : <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">{text}</div>;
}

function InstallLog({ log }: { log: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [log]);
  return <pre ref={ref} className="mt-4 max-h-60 overflow-auto rounded-xl bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-300">{log.join('\n')}</pre>;
}
