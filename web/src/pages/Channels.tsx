import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Trash2, Plus } from 'lucide-react';
import { useData } from '../live';
import { del, put, fmtDate, type Channel, type Project } from '../api';
import { Button, PageHeader, PlatformIcon, useAction, toast, Badge } from '../ui';

const PLATFORMS = [
  { id: 'youtube', name: 'YouTube', key: 'youtube', blurb: 'Uploads as Shorts (vertical, under 3 min) or regular videos. YouTube publishes them at the scheduled time.', needs: 'Google Cloud OAuth client' },
  { id: 'instagram', name: 'Instagram', key: 'meta', blurb: 'Posts Reels at the scheduled time. Needs a Business or Creator account linked to a Facebook Page.', needs: 'Meta developer app' },
] as const;

export default function Channels() {
  const { data: channels } = useData<Channel[]>('/channels');
  const { data: projects } = useData<Project[]>('/projects');
  const { data: health } = useData<{ checks: { id: string; ok: boolean }[] }>('/health');
  const [params, setParams] = useSearchParams();
  const { busy, run } = useAction();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const err = params.get('error'); const ok = params.get('connected');
    if (err) setError(err);
    if (ok) { setError(null); toast(`Connected ${ok} account${ok === '1' ? '' : 's'}. Link ${ok === '1' ? 'it' : 'them'} to a project to start posting.`); }
    if (err || ok) setParams({}, { replace: true });
  }, [params, setParams]);

  return (
    <>
      <PageHeader title="Channels" subtitle="Connect the accounts videos are published to, then link them to projects." />
      {error && (
        <div className="mb-4 flex items-start gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/20">
          <div className="flex-1"><b>Connecting failed:</b> {error}</div>
          <button onClick={() => setError(null)} className="text-xs underline">Dismiss</button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {PLATFORMS.map((p) => {
          const configured = health?.checks.find((c) => c.id === p.key)?.ok;
          const list = channels?.filter((c) => c.platform === p.id) ?? [];
          return (
            <section key={p.id} className="card p-5">
              <div className="flex items-start gap-3">
                <PlatformIcon platform={p.id} className="size-9" />
                <div className="flex-1"><h2 className="font-semibold">{p.name}</h2><p className="mt-0.5 text-sm text-zinc-500">{p.blurb}</p></div>
              </div>
              <div className="mt-4 space-y-2">
                {list.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-xl border border-zinc-200 px-3 py-2.5 dark:border-zinc-700">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{c.name}</div>
                      <div className="text-xs text-zinc-500">Connected {fmtDate(c.created_at, { dateStyle: 'medium' })}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-zinc-500">Posts for:</span>
                        {projects?.length ? projects.map((pr) => {
                          const on = c.projects.includes(pr.id);
                          return (
                            <button key={pr.id} disabled={busy === `l${c.id}`}
                              onClick={() => run(`l${c.id}`, async () => {
                                const next = on ? c.projects.filter((x) => x !== pr.id) : [...c.projects, pr.id];
                                await put(`/channels/${c.id}/projects`, { project_ids: next });
                                if (!on) toast(`${c.name} now posts ${pr.name} videos`);
                              })}
                              className={`rounded-full px-2.5 py-0.5 text-xs transition ${on ? 'bg-accent-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300'}`}>
                              {on ? '✓ ' : '+ '}{pr.name}
                            </button>
                          );
                        }) : <span className="text-xs text-zinc-400">no projects yet</span>}
                      </div>
                      {!c.projects.length && <div className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">Not linked yet — pick the projects whose videos this channel should post.</div>}
                    </div>
                    <Badge tone={c.status === 'connected' ? 'green' : 'red'}>{c.status}</Badge>
                    <Button size="sm" variant="ghost" loading={busy === `d${c.id}`} icon={<Trash2 className="size-3.5" />}
                      onClick={() => confirm(`Disconnect ${c.name}? Scheduled posts to it are removed.`) && run(`d${c.id}`, () => del(`/channels/${c.id}`))} />
                  </div>
                ))}
              </div>
              <div className="mt-4">
                {configured ? (
                  <a href={`/api/oauth/${p.id}/start`}><Button variant="primary" icon={<Plus className="size-4" />}>{list.length ? 'Connect another' : `Connect ${p.name}`}</Button></a>
                ) : (
                  <div className="rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">
                    First add your {p.needs} in <Link to="/settings#connections" className="font-medium text-accent-600 underline">Settings → Connections</Link>. Step-by-step instructions are there.
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
