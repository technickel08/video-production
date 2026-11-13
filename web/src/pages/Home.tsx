import { Link } from 'react-router-dom';
import { Plus, Hourglass, PauseCircle, FlaskConical, AlertTriangle, ArrowRight } from 'lucide-react';
import { useData } from '../live';
import { fmtDate, type Video } from '../api';
import { Button, PageHeader, Empty, PlatformIcon } from '../ui';
import { VideoRow } from '../components';

export default function Home() {
  const { data: o } = useData<any>('/overview');
  const { data: health } = useData<{ checks: { id: string; ok: boolean; label: string }[] }>('/health');
  const { data: projects } = useData<any[]>('/projects');
  if (!o) return null;
  const problems = health?.checks.filter((c) => !c.ok && !['youtube', 'meta', 'cloudflared', 'mock'].includes(c.id)) ?? [];

  const tiles = [
    { label: 'In progress', value: o.inProgress, to: '/pipeline', tone: 'text-accent-600 dark:text-accent-500' },
    { label: 'Needs approval', value: o.awaiting, to: '/approvals', tone: 'text-orange-600' },
    { label: 'Scheduled', value: o.scheduled, to: '/calendar', tone: 'text-sky-600' },
    { label: 'Published', value: o.published, to: '/calendar', tone: 'text-emerald-600' },
    { label: 'Failed', value: o.failed, to: '/pipeline', tone: o.failed ? 'text-red-600' : 'text-zinc-400' },
  ];

  return (
    <>
      <PageHeader title="Good to see you" subtitle="Here's what your autopilot is doing."
        actions={<Link to="/projects/new"><Button variant="primary" icon={<Plus className="size-4" />}>New project</Button></Link>} />

      <div className="mb-6 space-y-2">
        {o.paused && <Banner tone="amber" icon={<PauseCircle className="size-4" />}>Automation is paused. Nothing new will run or publish until you resume it.</Banner>}
        {o.usageWaitUntil && <Banner tone="amber" icon={<Hourglass className="size-4" />}>Claude usage limit reached. Work resumes automatically around {fmtDate(o.usageWaitUntil, { timeStyle: 'short', dateStyle: 'short' })}.</Banner>}
        {o.mock && <Banner tone="amber" icon={<FlaskConical className="size-4" />}>Test mode is on: steps write sample files and a test-pattern video without using Claude. <Link to="/settings" className="underline">Turn off in Settings</Link>.</Banner>}
        {problems.length > 0 && <Banner tone="red" icon={<AlertTriangle className="size-4" />}>Setup needed: {problems.map((p) => p.label).join(', ')}. <Link to="/settings" className="underline">Open setup</Link>.</Banner>}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="card p-4 transition hover:-translate-y-0.5 hover:shadow-md">
            <div className="text-xs font-medium text-zinc-500">{t.label}</div>
            <div className={`mt-1 text-3xl font-semibold tabular-nums ${t.tone}`}>{t.value}</div>
          </Link>
        ))}
      </div>

      {!projects?.length ? (
        <Empty title="Create your first project" body="A project holds the niche, format, style and channels. The autopilot then researches, produces and schedules videos for it."
          action={<Link to="/projects/new"><Button variant="primary" icon={<Plus className="size-4" />}>New project</Button></Link>} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          <section className="card p-4 lg:col-span-3">
            <div className="mb-2 flex items-center justify-between px-2"><h2 className="font-semibold">Recent activity</h2>
              <Link to="/pipeline" className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-white">Pipeline <ArrowRight className="size-3" /></Link></div>
            {o.recent.length ? o.recent.map((v: Video) => <VideoRow key={v.id} v={v} />) : <p className="px-2 py-6 text-sm text-zinc-500">No videos yet. Open a project and press “Make a video now”.</p>}
          </section>
          <div className="space-y-4 lg:col-span-2">
            <section className="card p-4">
              <h2 className="mb-2 px-2 font-semibold">Next to publish</h2>
              {o.next.length ? o.next.map((p: any) => (
                <Link key={p.id} to={`/videos/${p.video_id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                  <PlatformIcon platform={p.platform} className="size-5" />
                  <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{p.title}</div><div className="text-xs text-zinc-500">{p.channel_name}</div></div>
                  <div className="text-right text-xs text-zinc-500">{fmtDate(p.scheduled_at, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</div>
                </Link>
              )) : <p className="px-2 py-4 text-sm text-zinc-500">Nothing scheduled.</p>}
            </section>
            <section className="card p-4">
              <h2 className="mb-3 px-2 font-semibold">Last 30 days</h2>
              <div className="grid grid-cols-3 gap-2 px-2">
                {[['Views', o.totals?.views], ['Likes', o.totals?.likes], ['Comments', o.totals?.comments]].map(([l, v]) => (
                  <div key={l as string}><div className="text-xs text-zinc-500">{l}</div><div className="text-xl font-semibold tabular-nums">{Number(v ?? 0).toLocaleString()}</div></div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </>
  );
}

function Banner({ tone, icon, children }: { tone: 'amber' | 'red'; icon: React.ReactNode; children: React.ReactNode }) {
  const t = tone === 'red' ? 'bg-red-50 text-red-800 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/20'
    : 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20';
  return <div className={`flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm ring-1 ${t}`}><span className="mt-0.5">{icon}</span><div>{children}</div></div>;
}
