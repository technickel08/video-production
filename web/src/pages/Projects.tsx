import { Link, useNavigate } from 'react-router-dom';
import { Plus, Sparkles, Clock, Ratio, Languages } from 'lucide-react';
import { useData } from '../live';
import { post, put, fmtDate, type Project, type Channel } from '../api';
import { Button, PageHeader, Empty, Toggle, useAction, toast, PlatformIcon, Badge } from '../ui';

export default function Projects() {
  const { data: projects } = useData<Project[]>('/projects');
  const { data: channels } = useData<Channel[]>('/channels');
  const { busy, run } = useAction();
  const nav = useNavigate();
  if (!projects) return null;

  return (
    <>
      <PageHeader title="Projects" subtitle="Each project has its own niche, format, style, channels and posting rhythm."
        actions={<Link to="/projects/new"><Button variant="primary" icon={<Plus className="size-4" />}>New project</Button></Link>} />
      {!projects.length ? (
        <Empty title="No projects yet" body="Start with a niche and a format. You can change everything later."
          action={<Link to="/projects/new"><Button variant="primary" icon={<Plus className="size-4" />}>New project</Button></Link>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => {
            const chans = channels?.filter((c) => p.channel_ids.includes(c.id)) ?? [];
            const c = p.counts ?? {};
            return (
              <div key={p.id} className={`card flex flex-col p-5 ${!p.active ? 'opacity-60' : ''}`}>
                <Link to={`/projects/${p.id}`} className="group">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-lg font-semibold tracking-tight group-hover:text-accent-600">{p.name}</h3>
                    {!p.active && <Badge>Paused</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{p.niche || 'No niche set'}</p>
                </Link>
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-zinc-500">
                  <span className="flex items-center gap-1"><Ratio className="size-3.5" />{p.aspect_ratio} · {p.duration_sec}s</span>
                  <span className="flex items-center gap-1"><Languages className="size-3.5" />{p.language}</span>
                  <span className="flex items-center gap-1"><Clock className="size-3.5" />{p.post_times.join(', ')}</span>
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  {chans.length ? chans.map((ch) => <span key={ch.id} title={ch.name}><PlatformIcon platform={ch.platform} /></span>)
                    : <span className="text-xs text-zinc-400">No channels linked</span>}
                </div>
                <div className="mt-4 grid grid-cols-4 gap-2 border-t border-zinc-100 pt-4 text-center dark:border-zinc-800">
                  {[['Working', (c.queued ?? 0) + (c.running ?? 0) + (c.waiting_usage ?? 0)], ['Review', (c.awaiting_approval ?? 0) + (c.awaiting_review ?? 0)], ['Scheduled', (c.scheduled ?? 0) + (c.ready_to_publish ?? 0)], ['Live', c.published ?? 0]].map(([l, n]) => (
                    <div key={l as string}><div className="text-lg font-semibold tabular-nums">{n}</div><div className="text-[11px] text-zinc-500">{l}</div></div>
                  ))}
                </div>
                <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <Toggle checked={p.autopilot} label="Autopilot" hint={p.autopilot ? `Up to ${p.daily_cap}/day · next slot ${fmtDate(p.next_slot, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Only makes videos when you ask'}
                    onChange={(v) => run(`ap${p.id}`, () => put(`/projects/${p.id}`, { autopilot: v }))} />
                </div>
                <Button className="mt-3" variant="primary" icon={<Sparkles className="size-4" />} loading={busy === `run${p.id}`}
                  onClick={() => run(`run${p.id}`, async () => { const v = await post(`/projects/${p.id}/run`); toast('Started a new video'); nav(`/videos/${v.id}`); })}>
                  Make a video now
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
