import { useEffect, useState } from 'react';
import { Play, LogIn } from 'lucide-react';
import { api, post } from '../api';
import { Button } from '../ui';

export default function Login() {
  const params = new URLSearchParams(window.location.search);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(params.get('error') ?? '');
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);

  useEffect(() => {
    api<{ required: boolean; user: unknown; google: boolean }>('/auth/me').then((me) => {
      if (!me.required || me.user) window.location.replace('/');
      setGoogle(me.google);
    }).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await post('/auth/login', { password }); window.location.replace('/'); }
    catch (err: any) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-accent-600 text-white"><Play className="size-5 fill-current" /></span>
          <div><div className="text-lg font-semibold">Video Autopilot</div><div className="text-xs text-zinc-500">Sign in to continue</div></div>
        </div>
        {error && <div className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/20">{error}</div>}
        {google && <>
          <a href="/api/auth/google/start" className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800">
            <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.500-.2-2.200H12v4.200h5.900a5.100 5.100 0 0 1-2.200 3.300v2.700h3.600c2.100-1.900 3.300-4.800 3.300-8z" /><path fill="#34A853" d="M12 23c3 0 5.500-1 7.300-2.700l-3.600-2.700c-1 .7-2.300 1.100-3.700 1.100-2.900 0-5.300-1.900-6.200-4.500H2.100v2.800A11 11 0 0 0 12 23z" /><path fill="#FBBC05" d="M5.800 14.200a6.600 6.600 0 0 1 0-4.200V7.200H2.100a11 11 0 0 0 0 9.800l3.700-2.800z" /><path fill="#EA4335" d="M12 5.400c1.600 0 3.100.600 4.200 1.600l3.200-3.200A11 11 0 0 0 2.100 7.200L5.800 10c.9-2.600 3.300-4.600 6.200-4.600z" /></svg>
            Continue with Google
          </a>
          <div className="my-4 flex items-center gap-3 text-xs text-zinc-400"><span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />or admin<span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" /></div>
        </>}
        <form onSubmit={submit}>
          <label className="label" htmlFor="pw">Admin password</label>
          <input id="pw" className="input" type="password" autoComplete="current-password" autoFocus={!google} value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" variant="primary" className="mt-3 w-full" loading={busy} disabled={!password} icon={<LogIn className="size-4" />}>Sign in</Button>
        </form>
      </div>
    </div>
  );
}
