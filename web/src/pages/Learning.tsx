import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Brain, Check, X, Undo2, Pin, PinOff, Strikethrough, RotateCcw, RefreshCw, AlertTriangle } from 'lucide-react';
import { useData } from '../live';
import { post, put, fmtDate, usageLabel, type LearningData, type Project, type Proposal, type Lesson, type Metric } from '../api';
import { Button, PageHeader, Empty, Section, Badge, useAction, toast } from '../ui';

const LEVEL: Record<string, { label: string; tone: 'zinc' | 'accent' | 'amber' }> = {
  tweak: { label: 'Tweak', tone: 'zinc' }, shift: { label: 'Shift', tone: 'accent' }, pivot: { label: 'Pivot', tone: 'amber' },
};
const fmtChange = (k: string, v: any) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') || '—' : v === '' ? '—' : v}`;

export default function Learning() {
  const { pid } = useParams();
  const nav = useNavigate();
  const { data: projects } = useData<Project[]>('/projects');
  useEffect(() => { if (!pid && projects?.length) nav(`/learning/${projects[0].id}`, { replace: true }); }, [pid, projects]);
  const { data: d, reload } = useData<LearningData>(pid ? `/learning/${pid}` : null);
  const { busy, run } = useAction();
  if (!projects) return null;
  if (!projects.length) return <><PageHeader title="Learning" /><Empty icon={<Brain className="size-6" />} title="No projects yet" /></>;
  if (!d) return null;

  const act = (key: string, path: string, msg: string) => run(key, async () => { await post(path); toast(msg); reload(); });
  const pending = d.proposals.filter((p) => p.status === 'pending');
  const history = d.proposals.filter((p) => p.status !== 'pending');
  const lessons = d.playbook?.lessons ?? [];
  const lastJob = d.jobs[0];

  return (
    <>
      <PageHeader title="Learning" subtitle="What the system has learned from posted videos, and the changes it proposes or made."
        actions={<>
          <select className="input w-auto" value={pid} onChange={(e) => nav(`/learning/${e.target.value}`)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <Button icon={<RefreshCw className={`size-4 ${d.running ? 'animate-spin' : ''}`} />} loading={busy === 'an'} disabled={d.running || d.queued}
            onClick={() => act('an', `/learning/${pid}/analyse`, 'Analysis queued — it runs when no video step is working')}>{d.running ? 'Analysing…' : d.queued ? 'Queued' : 'Analyse now'}</Button>
        </>} />

      {(d.analytics_missing || d.analytics_error) && (
        <div className="mb-4 flex gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div><b>Watch-time numbers are missing.</b> Views and likes still work, but the share watched and retention need YouTube Analytics. In Google Cloud, enable <b>YouTube Analytics API</b>, then <Link to="/channels" className="underline">reconnect YouTube</Link> and allow the new permission.
            {d.analytics_error && <div className="mt-1 text-xs opacity-80">YouTube said: {d.analytics_error}</div>}</div>
        </div>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Published" value={d.published} />
        <Stat label="Measured (24h+)" value={d.measured} hint={d.measured < 10 ? 'Lessons stay low-confidence until about 10' : undefined} />
        <Stat label="Data" value={d.playbook?.data_quality ?? '—'} />
        <Stat label="Last analysis" value={d.project.analyzed_at ? fmtDate(d.project.analyzed_at, { dateStyle: 'medium' }) : 'not yet'} hint={lastJob?.cost_usd ? `usage ≈ ${usageLabel(lastJob.cost_usd)}` : lastJob?.status === 'failed' ? `failed: ${lastJob.error ?? ''}` : undefined} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          {!!pending.length && (
            <Section title="Waiting for you" description="Pivots always ask. Shifts ask unless the project is set to fully automatic.">
              <div className="space-y-3">{pending.map((p) => <ProposalCard key={p.id} p={p} busy={busy}
                approve={() => act(`a${p.id}`, `/proposals/${p.id}/approve`, 'Change applied')} dismiss={() => act(`d${p.id}`, `/proposals/${p.id}/dismiss`, 'Dismissed')} />)}</div>
            </Section>
          )}

          <Section title="Playbook" description={d.playbook?.summary ?? 'The analyst writes this after 3 published videos have at least a day of numbers.'}>
            {!lessons.length ? <p className="text-sm text-zinc-500">No lessons yet.</p> : (
              <ul className="space-y-2">{lessons.map((l) => <LessonRow key={l.id} l={l} busy={busy}
                set={(status) => run(`l${l.id}`, async () => { await put(`/learning/${pid}/lessons/${l.id}`, { status }); reload(); })} />)}</ul>
            )}
            {!!d.playbook?.next_tests?.length && <div className="mt-4"><div className="label">Worth testing next</div><ul className="list-disc space-y-0.5 pl-5 text-sm text-zinc-600 dark:text-zinc-300">{d.playbook.next_tests.map((t) => <li key={t}>{t}</li>)}</ul></div>}
            {!!d.playbook?.unknowns?.length && <div className="mt-3"><div className="label">Still unknown</div><ul className="list-disc space-y-0.5 pl-5 text-sm text-zinc-500">{d.playbook.unknowns.map((t) => <li key={t}>{t}</li>)}</ul></div>}
            <p className="mt-3 text-xs text-zinc-500">Pin a lesson to make it a rule; strike it to stop the system using or re-learning it. Research, script and production read this before every video.</p>
          </Section>

          <Section title="Results" description="Numbers frozen at fixed ages, so new and old videos compare fairly. % watched is the average share of the video people watched.">
            <Results d={d} />
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="Mode">
            <p className="text-sm text-zinc-600 dark:text-zinc-300">{d.project.adapt_mode === 'auto' ? 'Fully automatic: confident tweaks and shifts apply by themselves; you are told and can undo.' : 'Ask me: confident tweaks apply by themselves; shifts and pivots wait for you.'}</p>
            <p className="mt-2 text-xs text-zinc-500">You approved {d.stats.approved} and turned down {d.stats.dismissed} proposal(s) here. Change this under <Link to={`/projects/${pid}`} className="underline">project settings → Automation</Link>.</p>
            {d.project.focus && <p className="mt-3 text-sm"><span className="label">Current focus</span>{d.project.focus}</p>}
          </Section>
          <Section title="Changes made">
            {!history.length ? <p className="text-sm text-zinc-500">Nothing yet.</p> : (
              <ul className="space-y-3">{history.map((p) => (
                <li key={p.id} className="text-sm">
                  <div className="flex items-center gap-2"><Badge tone={LEVEL[p.level].tone}>{LEVEL[p.level].label}</Badge><span className="font-medium">{p.title}</span></div>
                  <div className="mt-0.5 text-xs text-zinc-500">{p.status === 'applied' ? (p.auto ? 'Applied automatically' : 'Approved') : p.status[0].toUpperCase() + p.status.slice(1)} · {fmtDate(p.decided_at ?? p.created_at, { dateStyle: 'medium' })}</div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-300">{Object.entries(p.changes).map(([k, v]) => fmtChange(k, v)).join(' · ')}</div>
                  {p.status === 'applied' && <Button size="sm" variant="ghost" className="mt-1 -ml-2" icon={<Undo2 className="size-3.5" />} loading={busy === `u${p.id}`} onClick={() => act(`u${p.id}`, `/proposals/${p.id}/undo`, 'Change undone')}>Undo</Button>}
                </li>
              ))}</ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <div className="card p-4"><div className="text-xs text-zinc-500">{label}</div><div className="mt-1 text-lg font-semibold capitalize">{value}</div>{hint && <div className="mt-0.5 text-[11px] text-zinc-500">{hint}</div>}</div>;
}

function ProposalCard({ p, busy, approve, dismiss }: { p: Proposal; busy: string | null; approve: () => void; dismiss: () => void }) {
  return (
    <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-2"><Badge tone={LEVEL[p.level].tone}>{LEVEL[p.level].label}</Badge><span className="font-medium">{p.title}</span><span className="text-xs text-zinc-500">{p.confidence} confidence</span></div>
      <div className="mt-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-800/60">{Object.entries(p.changes).map(([k, v]) => <div key={k}>{fmtChange(k, v)}</div>)}</div>
      {p.reason && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{p.reason}</p>}
      {p.evidence && <p className="mt-1 text-xs text-zinc-500">Evidence: {p.evidence}</p>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="primary" icon={<Check className="size-4" />} loading={busy === `a${p.id}`} onClick={approve}>Approve</Button>
        <Button size="sm" icon={<X className="size-4" />} loading={busy === `d${p.id}`} onClick={dismiss}>Dismiss</Button>
      </div>
    </div>
  );
}

function LessonRow({ l, busy, set }: { l: Lesson; busy: string | null; set: (s: Lesson['status']) => void }) {
  const struck = l.status === 'struck';
  return (
    <li className={`flex items-start gap-3 rounded-xl px-3 py-2 ${l.status === 'pinned' ? 'bg-accent-50 dark:bg-accent-500/10' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className={`text-sm ${struck ? 'text-zinc-400 line-through' : ''}`}>{l.text}</div>
        <div className="mt-0.5 text-xs text-zinc-500">{l.status === 'pinned' ? 'Pinned by you' : `${l.confidence ?? 'low'} confidence`}{l.evidence ? ` · ${l.evidence}` : ''}</div>
      </div>
      <div className="flex shrink-0 gap-1">
        {l.status !== 'struck' && <Button size="sm" variant="ghost" title={l.status === 'pinned' ? 'Unpin' : 'Pin as a rule'} loading={busy === `l${l.id}`} onClick={() => set(l.status === 'pinned' ? 'active' : 'pinned')}
          icon={l.status === 'pinned' ? <PinOff className="size-4" /> : <Pin className="size-4" />} />}
        {struck ? <Button size="sm" variant="ghost" title="Use again" icon={<RotateCcw className="size-4" />} onClick={() => set('active')} />
          : <Button size="sm" variant="ghost" title="Strike out" icon={<Strikethrough className="size-4" />} onClick={() => set('struck')} />}
      </div>
    </li>
  );
}

const fmt = (n: number | undefined | null, suffix = '') => n == null || Number.isNaN(n) ? '—' : `${Math.round(n * 10) / 10}${suffix}`;
function Results({ d }: { d: LearningData }) {
  if (!d.videos.length) return <p className="text-sm text-zinc-500">No published videos yet.</p>;
  const med = d.medians.youtube?.['24h']?.views ?? null;
  const pick = (v: LearningData['videos'][number], plat: string): Metric | undefined => v.platforms[plat]?.['7d'] ?? v.platforms[plat]?.['3d'] ?? v.platforms[plat]?.['24h'] ?? v.platforms[plat]?.latest;
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead><tr className="text-left text-xs text-zinc-500">
          <th className="px-2 py-1.5 font-medium">Video</th><th className="px-2 font-medium">YT 24h</th><th className="px-2 font-medium">YT 3d</th><th className="px-2 font-medium">YT 7d</th>
          <th className="px-2 font-medium">% watched</th><th className="px-2 font-medium">Retention</th><th className="px-2 font-medium">IG views</th>
        </tr></thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {d.videos.map((v) => {
            const yt = v.platforms.youtube ?? {}; const best = pick(v, 'youtube'); const ig = pick(v, 'instagram');
            const ratio = med && yt['24h']?.views != null ? yt['24h'].views / med : null;
            return (
              <tr key={v.id}>
                <td className="max-w-[260px] px-2 py-2"><Link to={`/videos/${v.id}`} className="line-clamp-1 hover:text-accent-600">{v.title}</Link>
                  <div className="text-[11px] text-zinc-500">{[v.tags?.topic_type, v.tags?.timeliness, v.tags?.hook_type, v.style].filter(Boolean).join(' · ')}</div></td>
                <td className="px-2">{fmt(yt['24h']?.views)}{ratio != null && ratio >= 2 && <span className="ml-1 text-[11px] text-emerald-600">{Math.round(ratio)}×</span>}</td>
                <td className="px-2">{fmt(yt['3d']?.views)}</td><td className="px-2">{fmt(yt['7d']?.views)}</td>
                <td className="px-2">{fmt(best?.avg_view_pct, '%')}</td>
                <td className="px-2"><Spark values={(yt['7d'] ?? yt['3d'] ?? yt['24h'])?.retention} /></td>
                <td className="px-2">{fmt(ig?.views)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {med != null && <p className="mt-2 px-2 text-xs text-zinc-500">Channel median at 24h: {fmt(med)} views on YouTube. “2×” marks a video at least twice the median.</p>}
    </div>
  );
}

function Spark({ values }: { values?: number[] }) {
  if (!values?.length) return <span className="text-zinc-400">—</span>;
  const w = 80, h = 22; const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * h}`).join(' ');
  return <svg width={w} height={h} className="text-accent-500" aria-label="Retention curve"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}
