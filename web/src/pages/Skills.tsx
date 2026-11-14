import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Puzzle, Plus, X, Trash2, Search, ExternalLink, ChevronDown, FlaskConical } from 'lucide-react';
import { useData } from '../live';
import { post, del, fmtDate, ago, usageLabel, type SkillRow, type Project } from '../api';
import { Button, PageHeader, Empty, Section, Badge, Modal, useAction, toast } from '../ui';

interface SkillsData { skills: SkillRow[]; report: string; running: boolean; last_run: string | null; enabled: boolean; every_days: number;
  jobs: { id: number; status: string; cost_usd: number | null; error: string | null; started_at: string }[] }

const KIND: Record<string, string> = { visual: 'Visual style', voice: 'Voice', music: 'Music', captions: 'Captions', other: 'Other' };
const RISK = { low: 'green', medium: 'amber', high: 'red' } as const;

export default function Skills() {
  const { data: d, reload } = useData<SkillsData>('/skills');
  const { data: projects } = useData<Project[]>('/projects');
  const { busy, run } = useAction();
  const [showReport, setShowReport] = useState(false);
  const [trying, setTrying] = useState<SkillRow | null>(null);
  if (!d) return null;

  const act = (key: string, fn: () => Promise<unknown>, msg: string) => run(key, async () => { await fn(); toast(msg); reload(); });
  const found = d.skills.filter((s) => s.status === 'found');
  const installed = d.skills.filter((s) => s.status === 'installed');
  const lastJob = d.jobs[0];

  return (
    <>
      <PageHeader title="Skills" subtitle="Extra video-making skills. The scout searches the web for better ones and vets them; you decide what gets added."
        actions={<Button icon={<Search className={`size-4 ${d.running ? 'animate-pulse' : ''}`} />} loading={busy === 'scout'} disabled={d.running}
          onClick={() => act('scout', () => post('/skills/scout'), 'Scout queued — it runs when no video step is working')}>{d.running ? 'Scouting…' : 'Run scout now'}</Button>} />

      <p className="mb-4 text-sm text-zinc-500">
        {d.enabled ? `Runs every ${d.every_days} days with Opus.` : 'Automatic scouting is off (Settings → Automation).'}{' '}
        {d.last_run ? `Last run ${ago(d.last_run)}` : 'Not run yet'}{lastJob?.cost_usd ? ` · usage ≈ ${usageLabel(lastJob.cost_usd)}` : ''}{lastJob?.status === 'failed' ? ` · last run failed: ${lastJob.error ?? ''}` : ''}.
      </p>

      {!!found.length && (
        <Section title="Found — waiting for you" description="Adding downloads that exact version from GitHub into the app's skills folder. Nothing in it runs until a video uses it.">
          <div className="grid gap-3 lg:grid-cols-2">{found.map((s) => <SkillCardView key={s.id} s={s}>
            <Button size="sm" variant="primary" icon={<Plus className="size-4" />} loading={busy === `i${s.id}`} onClick={() => act(`i${s.id}`, () => post(`/skills/${s.id}/install`), `${s.name} added`)}>Add</Button>
            <Button size="sm" icon={<X className="size-4" />} loading={busy === `d${s.id}`} onClick={() => act(`d${s.id}`, () => post(`/skills/${s.id}/dismiss`), 'Dismissed')}>Dismiss</Button>
          </SkillCardView>)}</div>
        </Section>
      )}

      <Section title="Added" description="Visual skills appear in each project's Visual style list under “Other skills”. Voice, music and caption skills are switched on per project under Sound.">
        {!installed.length ? <p className="text-sm text-zinc-500">None yet. The built-in lemo-opuscar skill is always available.</p> : (
          <div className="grid gap-3 lg:grid-cols-2">{installed.map((s) => <SkillCardView key={s.id} s={s}>
            {s.kind === 'visual' && <Button size="sm" icon={<FlaskConical className="size-4" />} onClick={() => setTrying(s)}>Try on next video</Button>}
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} loading={busy === `r${s.id}`}
              onClick={() => confirm(`Remove ${s.name}? Projects using it go back to their other styles.`) && act(`r${s.id}`, () => del(`/skills/${s.id}`), 'Removed')}>Remove</Button>
          </SkillCardView>)}</div>
        )}
      </Section>

      {d.report && (
        <div className="card mt-4 p-4">
          <button onClick={() => setShowReport(!showReport)} className="flex items-center gap-1 text-sm font-medium text-accent-600"><ChevronDown className={`size-4 transition ${showReport ? '' : '-rotate-90'}`} />Latest scout report</button>
          {showReport && <div className="prose-sm mt-3"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>{d.report}</ReactMarkdown></div>}
        </div>
      )}
      {!d.skills.length && !d.report && <Empty icon={<Puzzle className="size-6" />} title="No finds yet" body="Press “Run scout now”, or wait for the next scheduled run." />}

      <TryModal skill={trying} projects={projects ?? []} onClose={() => setTrying(null)} />
    </>
  );
}

function SkillCardView({ s, children }: { s: SkillRow; children: React.ReactNode }) {
  const c = s.card;
  return (
    <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{s.name}</span><Badge>{KIND[s.kind] ?? s.kind}</Badge>
        {c.risk && <Badge tone={RISK[c.risk]}>{c.risk} risk</Badge>}
        {c.recommendation && s.status === 'found' && <span className="text-xs text-zinc-500">scout says: {c.recommendation}</span>}
      </div>
      {c.summary && <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-300">{c.summary}</p>}
      {c.better_because && <p className="mt-1 text-sm"><span className="text-zinc-500">Why: </span>{c.better_because}</p>}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-zinc-500">
        {c.runs && <><dt>Runs</dt><dd className="text-zinc-700 dark:text-zinc-300">{c.runs}</dd></>}
        <dt>Internet</dt><dd className="text-zinc-700 dark:text-zinc-300">{c.network || 'not stated'}</dd>
        {!!c.needs_keys?.length && <><dt>Needs</dt><dd className="text-amber-700 dark:text-amber-300">{c.needs_keys.join(', ')}</dd></>}
        <dt>Licence</dt><dd className="text-zinc-700 dark:text-zinc-300">{c.license || 'unknown'}{c.last_commit ? ` · updated ${c.last_commit}` : ''}{c.stars ? ` · ${c.stars}★` : ''}</dd>
        {c.risk_notes && <><dt>Checked</dt><dd className="text-zinc-700 dark:text-zinc-300">{c.risk_notes}</dd></>}
        {s.status === 'installed' && <><dt>Version</dt><dd className="font-mono text-zinc-700 dark:text-zinc-300">{s.ref?.slice(0, 7)} · added {fmtDate(s.installed_at, { dateStyle: 'medium' })}</dd></>}
      </dl>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <a href={`${s.repo}${s.subpath ? `/tree/${s.ref ?? 'HEAD'}/${s.subpath}` : ''}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-600 underline"><ExternalLink className="size-3" />Source</a>
        {c.sample_url && <a href={c.sample_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-600 underline"><ExternalLink className="size-3" />Sample</a>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function TryModal({ skill, projects, onClose }: { skill: SkillRow | null; projects: Project[]; onClose: () => void }) {
  const [pid, setPid] = useState<number | null>(null);
  const { busy, run } = useAction();
  if (!skill) return null;
  const chosen = pid ?? projects[0]?.id;
  return (
    <Modal open onClose={onClose} title={`Try ${skill.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!chosen} loading={busy === 'ok'} onClick={() => run('ok', async () => { await post(`/skills/${skill.id}/try`, { projectId: chosen }); toast('The next video of that project will use it'); onClose(); })}>Use on next video</Button></>}>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">The next video made for this project uses {skill.name}, once. Compare it with the others in Learning before adding it to the project's styles.</p>
      <div><label className="label">Project</label>
        <select className="input" value={chosen} onChange={(e) => setPid(Number(e.target.value))}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
    </Modal>
  );
}
