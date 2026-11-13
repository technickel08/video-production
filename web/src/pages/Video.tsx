import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Archive, ArchiveRestore, Check, RotateCcw, Trash2, ThumbsDown, ExternalLink, FileText, Image as ImageIcon, Film, Braces, Music, Square, Download, Send } from 'lucide-react';
import { useData, useLive } from '../live';
import { post, put, del, fileUrl, fmtDate, duration, toLocalInput, STAGE_LABEL, VISIBILITY, usageLabel, USAGE_HINT, stepsFor, REVIEW_STAGES, type VideoDetail, type Stage, type Artifact, type Visibility } from '../api';
import { VisibilityPicker } from './ProjectEdit';
import { Button, StatusBadge, Modal, useAction, toast, PlatformIcon, Badge } from '../ui';
import { StepIcon } from '../components';


export default function VideoPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: v, error } = useData<VideoDetail>(`/videos/${id}`);
  const { busy, run } = useAction();
  const [selected, setSelected] = useState<Stage | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [redoOpen, setRedoOpen] = useState(false);

  const STEPS = stepsFor(!v || v.project.production_step || v.stage === 'production' || v.artifacts.some((a) => a.stage === 'production'));
  useEffect(() => { if (v && !selected) setSelected(STEPS.includes(v.stage) ? v.stage : 'check'); }, [v, selected]);
  // When a step finishes and waits for review, show that step.
  useEffect(() => { if (v?.status === 'awaiting_review') setSelected(v.stage); }, [v?.status, v?.stage]);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!v) return null;

  const stepState = (s: Stage): 'done' | 'running' | 'failed' | 'waiting' | 'todo' => {
    const cur = v.stage === 'done' ? STEPS.length : STEPS.indexOf(v.stage);
    const i = STEPS.indexOf(s);
    if (v.status === 'published' || i < cur) return 'done';
    if (i > cur) return 'todo';
    if (v.status === 'running') return 'running';
    if (v.status === 'failed') return 'failed';
    if (v.status === 'waiting_usage' || v.status === 'awaiting_review' || v.status === 'awaiting_approval' || v.status === 'scheduled' || v.status === 'ready_to_publish') return 'waiting';
    return 'todo';
  };
  const hasFilm = v.artifacts.some((a) => a.path === 'final.mp4');
  const canApprove = ['awaiting_approval', 'ready_to_publish'].includes(v.status) || (v.stage === 'publish' && v.status === 'failed');
  const isWorking = ['queued', 'running', 'waiting_usage'].includes(v.status);
  const totalUsage = v.runs.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
  const inReview = v.status === 'awaiting_review';
  const archived = v.status === 'archived';
  const canArchive = !archived && v.status !== 'published' && !v.posts.some((p) => ['scheduled', 'uploading', 'published'].includes(p.status));
  const nextStep = STEPS[STEPS.indexOf(v.stage) + 1] ?? 'produce';

  return (
    <>
      <Link to="/pipeline" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-white"><ArrowLeft className="size-4" />Pipeline</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
            <Link to={`/projects/${v.project_id}`} className="hover:underline">{v.project.name}</Link><span>·</span><span>#{v.id}</span><span>·</span><span>{fmtDate(v.created_at)}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{v.title || v.topic || 'Finding a topic…'}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2"><StatusBadge status={v.status} />
            {v.meta?.style && <Badge tone="accent">{v.meta.style}</Badge>}
            {['scheduled', 'ready_to_publish', 'published'].includes(v.status) && <Badge>{VISIBILITY.find((o) => o.id === v.visibility)?.label}</Badge>}
            {totalUsage > 0 && <span title={USAGE_HINT} className="cursor-help text-xs text-zinc-500">Usage ≈ {usageLabel(totalUsage)}</span>}
            {v.scheduled_at && <span className="text-xs text-zinc-500">Publishes {fmtDate(v.scheduled_at)}</span>}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {inReview && <Button variant="primary" icon={<Check className="size-4" />} loading={busy === 'continue'}
            onClick={() => run('continue', async () => { await post(`/videos/${v.id}/continue`); toast(`${STAGE_LABEL[v.stage]} approved — starting ${STAGE_LABEL[nextStep]}`); })}>Approve {STAGE_LABEL[v.stage].toLowerCase()}</Button>}
          {inReview && <Button icon={<ThumbsDown className="size-4" />} onClick={() => setRedoOpen(true)}>Request changes</Button>}
          {canApprove && <Button variant="primary" icon={<Check className="size-4" />} onClick={() => setApproveOpen(true)}>{v.status === 'ready_to_publish' ? 'Publish' : 'Approve'}</Button>}
          {v.status === 'scheduled' && v.posts.some((p) => p.status === 'pending') && (
            <Button variant="primary" icon={<Send className="size-4" />} loading={busy === 'now'}
              onClick={() => confirm('Publish this video now instead of at its scheduled time?') && run('now', async () => { await post(`/videos/${v.id}/publish-now`); toast('Publishing now — watch “Posts” for progress'); })}>
              Publish now
            </Button>
          )}
          {(canApprove || v.status === 'failed') && <Button icon={<ThumbsDown className="size-4" />} onClick={() => setRejectOpen(true)}>Request changes</Button>}
          {isWorking && v.running && <Button icon={<Square className="size-4" />} loading={busy === 'stop'} onClick={() => run('stop', async () => { await post(`/videos/${v.id}/reject`, { note: '' }); setRedoOpen(true); })}>Stop</Button>}
          {!isWorking && !inReview && !archived && v.status !== 'published' && <Button icon={<RotateCcw className="size-4" />} onClick={() => setRedoOpen(true)}>{v.status === 'failed' ? 'Retry' : 'Redo'}</Button>}
          {archived && <Button variant="primary" icon={<ArchiveRestore className="size-4" />} loading={busy === 'unarchive'}
            onClick={() => run('unarchive', async () => { await post(`/videos/${v.id}/unarchive`); toast('Restored'); })}>Restore</Button>}
          {canArchive && <Button icon={<Archive className="size-4" />} loading={busy === 'archive'} title="Keep this video for later without posting it"
            onClick={() => (v.status !== 'scheduled' || confirm('Archive this video? It will be taken off the schedule.')) && run('archive', async () => { await post(`/videos/${v.id}/archive`); toast('Archived — find it in Pipeline → Show archived'); })}>Archive</Button>}
          <Button variant="ghost" icon={<Trash2 className="size-4" />} loading={busy === 'del'}
            onClick={() => confirm('Delete this video and its files? Already-published posts stay on the platforms.') && run('del', async () => { await del(`/videos/${v.id}`); nav('/pipeline'); })} />
        </div>
      </div>

      {v.error && (
        <div className={`mb-4 whitespace-pre-wrap rounded-xl px-4 py-3 text-sm ring-1 ${v.status === 'failed' ? 'bg-red-50 text-red-800 ring-red-200 dark:bg-red-500/10 dark:text-red-200 dark:ring-red-500/20' : 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/20'}`}>{v.error}</div>
      )}
      {archived && (
        <div className="mb-4 rounded-xl bg-zinc-100 px-4 py-3 text-sm text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700">
          <b>Archived.</b> Nothing is posted or scheduled, and all files are kept. Press <b>Restore</b> when you want to {['approval', 'publish', 'done'].includes(v.stage) ? 'approve and schedule it' : 'continue it'}.
        </div>
      )}
      {inReview && (
        <div className="mb-4 rounded-xl bg-orange-50 px-4 py-3 text-sm text-orange-900 ring-1 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-200 dark:ring-orange-500/20">
          <b>{STAGE_LABEL[v.stage]} is ready for your review.</b> Read it below, then <b>Approve {STAGE_LABEL[v.stage].toLowerCase()}</b> to start {STAGE_LABEL[nextStep]}, or <b>Request changes</b> to have it redone with your feedback.
        </div>
      )}
      {v.note && isWorking && <div className="mb-4 whitespace-pre-wrap rounded-xl bg-accent-50 px-4 py-3 text-sm text-accent-700 ring-1 ring-accent-100 dark:bg-accent-500/10 dark:text-accent-100 dark:ring-accent-500/20"><b>Fixing:</b>{'\n'}{v.note}</div>}

      {/* Steps */}
      <div className="card mb-4 overflow-x-auto p-2">
        <div className="flex min-w-[640px]">
          {STEPS.map((s, i) => {
            const st = stepState(s); const runs = v.runs.filter((r) => r.stage === s); const last = runs.at(-1);
            return (
              <button key={s} onClick={() => setSelected(s)}
                className={`flex flex-1 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition ${selected === s ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'}`}>
                <StepIcon state={st} />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{i + 1}. {STAGE_LABEL[s]}</div>
                  <div className="truncate text-[11px] text-zinc-500">{last ? `${duration(last.started_at, last.finished_at)}${runs.length > 1 ? ` · ${runs.length} runs` : ''}${runs.some((r) => r.cost_usd) ? ` · ${usageLabel(runs.reduce((n, r) => n + (r.cost_usd ?? 0), 0))}` : ''}` : st === 'waiting' && s === 'approval' ? 'Waiting for you' : '—'}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-2">
          <div className="card p-3">
            {hasFilm ? (
              <video key={v.updated_at} controls playsInline poster={fileUrl(v.id, 'poster.jpg', v.updated_at)} src={fileUrl(v.id, 'final.mp4', v.updated_at)}
                className={`mx-auto w-full rounded-xl bg-black ${v.project.aspect_ratio === '9:16' ? 'max-h-[70vh] w-auto' : ''}`} />
            ) : (
              <div className="grid aspect-video place-items-center rounded-xl bg-zinc-100 text-sm text-zinc-500 dark:bg-zinc-800">
                <div className="text-center"><Film className="mx-auto mb-2 size-6" />{isWorking ? 'The video appears here when it is rendered' : 'No video yet'}</div>
              </div>
            )}
            {hasFilm && <a href={fileUrl(v.id, 'final.mp4')} download={`video-${v.id}.mp4`} className="mt-2 inline-flex items-center gap-1 px-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-white"><Download className="size-3.5" />Download MP4</a>}
          </div>
          {v.hook && (
            <div className="card p-4 text-sm">
              <div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">Hook check</h3>
                <div className="flex gap-1.5"><Badge tone={v.hook.hook_score >= 7 ? 'green' : 'amber'}>Hook {v.hook.hook_score}/10</Badge><Badge tone={v.hook.title_score >= 7 ? 'green' : 'amber'}>Title {v.hook.title_score}/10</Badge></div></div>
              {v.hook.hook_line && <p className="text-zinc-600 dark:text-zinc-300">“{v.hook.hook_line}”</p>}
              {!v.hook.pass && !!v.hook.issues?.length && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-300">{v.hook.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
              {!v.hook.pass && !!v.hook.better_titles?.length && <p className="mt-2 text-xs text-zinc-500">Title ideas: {v.hook.better_titles.join(' · ')}</p>}
            </div>
          )}
          {v.meta && <MetaEditor v={v} />}
          {v.posts.length > 0 && (
            <div className="card p-4">
              <h3 className="mb-2 font-semibold">Posts</h3>
              {v.posts.map((p) => (
                <div key={p.id} className="flex items-start gap-3 border-t border-zinc-100 py-2.5 first:border-0 dark:border-zinc-800">
                  <PlatformIcon platform={p.platform} className="mt-0.5 size-5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{p.channel_name}</div>
                    <div className="text-xs text-zinc-500">{p.status} · {fmtDate(p.scheduled_at)}</div>
                    {p.error && <div className="mt-1 text-xs text-red-600">{p.error}</div>}
                  </div>
                  {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-zinc-900 dark:hover:text-white"><ExternalLink className="size-4" /></a>}
                </div>
              ))}
            </div>
          )}
          {v.stats.length > 0 && (
            <div className="card p-4"><h3 className="mb-2 font-semibold">Performance</h3>
              {Object.entries(Object.groupBy(v.stats, (s) => s.platform)).map(([pl, rows]) => { const last = rows!.at(-1)!; return (
                <div key={pl} className="flex items-center gap-3 py-1.5 text-sm"><PlatformIcon platform={pl} />
                  <span className="tabular-nums">{(last.views ?? 0).toLocaleString()} views</span><span className="tabular-nums text-zinc-500">{last.likes ?? 0} likes · {last.comments ?? 0} comments</span></div>
              ); })}
            </div>
          )}
        </div>

        <div className="space-y-4 lg:col-span-3">
          {selected && <StagePanel v={v} stage={selected} />}
        </div>
      </div>

      <ApproveModal open={approveOpen} onClose={() => setApproveOpen(false)} v={v} />
      <RejectModal open={rejectOpen} onClose={() => setRejectOpen(false)} v={v} />
      <RedoModal open={redoOpen} onClose={() => setRedoOpen(false)} v={v} />
    </>
  );
}

const REDO_HINT: Record<string, string> = {
  research: 'Pick a new topic, then a new script and film',
  script: 'Keep the topic, rewrite the script, then a new film',
  production: 'Keep the script, redo scenes, cast, costumes and colours',
  produce: 'Keep the script and production design, make the film again',
  check: 'Run the quality check again on the current film',
  publish: 'Try the failed posts again',
};

function RedoModal({ open, onClose, v }: { open: boolean; onClose: () => void; v: VideoDetail }) {
  const prod = v.project.production_step || v.stage === 'production';
  const all: Stage[] = v.stage === 'publish' ? ['publish', 'produce', 'production', 'script', 'research'] : ['research', 'script', 'production', 'produce', 'check'];
  const inReview = v.status === 'awaiting_review';
  // While reviewing a step you can send back that step or an earlier one.
  const options = all.filter((s) => (s !== 'production' || prod) && (!inReview || REVIEW_STAGES.indexOf(s) <= REVIEW_STAGES.indexOf(v.stage) && REVIEW_STAGES.includes(s)));
  const [from, setFrom] = useState<Stage>(v.stage);
  const [feedback, setFeedback] = useState('');
  const { busy, run } = useAction();
  useEffect(() => { if (open) setFrom(options.includes(v.stage) ? v.stage : options[0]); }, [open]);
  const wantsFeedback = from !== 'publish' && from !== 'check';
  return (
    <Modal open={open} onClose={onClose} title={inReview ? 'Request changes' : v.status === 'failed' ? 'Retry' : 'Redo'}
      footer={<><Button variant="ghost" onClick={onClose}>{v.status === 'rejected' ? 'Leave stopped' : 'Cancel'}</Button>
        <Button variant="primary" icon={<RotateCcw className="size-4" />} loading={busy === 'ok'} onClick={() => run('ok', async () => {
          await post(`/videos/${v.id}/retry`, { stage: from, feedback: wantsFeedback ? feedback : '' });
          toast(feedback.trim() && wantsFeedback ? `Redoing from ${STAGE_LABEL[from]} with your feedback` : `Redoing from ${STAGE_LABEL[from]}`);
          setFeedback(''); onClose();
        })}>Start</Button></>}>
      {v.status === 'rejected' && <p className="text-sm text-zinc-500">Stopped. Tell Claude what to change and pick where to start again — or leave it stopped.</p>}
      <div><label className="label">Start again from</label>
        <div className="space-y-1.5">
          {options.map((s) => (
            <label key={s} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${from === s ? 'border-accent-500 bg-accent-50 dark:bg-accent-500/10' : 'border-zinc-200 dark:border-zinc-700'}`}>
              <input type="radio" checked={from === s} onChange={() => setFrom(s)} className="mt-1" />
              <span><span className="text-sm font-medium">{s === 'publish' ? 'Publish' : STAGE_LABEL[s]}{s === v.stage && <span className="ml-1.5 text-xs font-normal text-zinc-400">current step</span>}</span>
                <span className="block text-xs text-zinc-500">{REDO_HINT[s]}</span></span>
            </label>
          ))}
        </div></div>
      {wantsFeedback && <div><label className="label">Feedback for Claude <span className="font-normal text-zinc-400">(optional)</span></label>
        <textarea className="input min-h-28" value={feedback} onChange={(e) => setFeedback(e.target.value)} autoFocus
          placeholder={from === 'research' ? 'e.g. Pick something about the Chola navy; avoid the Mughals this time.' : from === 'production' ? 'e.g. Make the king older with a white beard; use deep reds and gold; set scene 2 at night.' : from === 'script' ? 'e.g. Start with the twist; shorter sentences; end with a question.' : 'e.g. Use a slower, deeper voice; bigger captions; fewer text cards.'} />
        {v.note && !feedback.trim() && <p className="mt-1 text-xs text-zinc-500">Leave empty to keep the current fix list.</p>}</div>}
    </Modal>
  );
}

function MetaEditor({ v }: { v: VideoDetail }) {
  const [m, setM] = useState({ title: v.meta?.title ?? '', description: v.meta?.description ?? '', hashtags: (v.meta?.hashtags ?? []).join(' ') });
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => { if (!dirty) setM({ title: v.meta?.title ?? '', description: v.meta?.description ?? '', hashtags: (v.meta?.hashtags ?? []).join(' ') }); }, [v.meta, dirty]);
  const locked = v.posts.some((p) => ['scheduled', 'published', 'uploading'].includes(p.status));
  const upd = (k: keyof typeof m, val: string) => { setM({ ...m, [k]: val }); setDirty(true); };
  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center justify-between"><h3 className="font-semibold">Title & caption</h3>{locked && <Badge>Uploaded</Badge>}</div>
      <div><label className="label">Title</label><input className="input" disabled={locked} value={m.title} onChange={(e) => upd('title', e.target.value)} maxLength={100} /></div>
      <div><label className="label">Description</label><textarea className="input min-h-28" disabled={locked} value={m.description} onChange={(e) => upd('description', e.target.value)} /></div>
      <div><label className="label">Hashtags</label><input className="input" disabled={locked} value={m.hashtags} onChange={(e) => upd('hashtags', e.target.value)} /></div>
      {dirty && <Button variant="primary" size="sm" loading={busy === 'save'} onClick={() => run('save', async () => {
        await put(`/videos/${v.id}/metadata`, { title: m.title, description: m.description, hashtags: m.hashtags.split(/\s+/).filter(Boolean).map((h) => (h.startsWith('#') ? h : `#${h}`)) });
        setDirty(false); toast('Saved');
      })}>Save</Button>}
    </div>
  );
}

// ─── Per-step panel: live log + files ────────────────────────────────────────
function StagePanel({ v, stage }: { v: VideoDetail; stage: Stage }) {
  const runs = v.runs.filter((r) => r.stage === stage);
  const [runId, setRunId] = useState<number | null>(null);
  const activeRun = runs.find((r) => r.id === runId) ?? runs.at(-1);
  const files = v.artifacts.filter((a) => a.stage === stage || (stage === 'approval' && a.path === 'final.mp4'));
  const [file, setFile] = useState<Artifact | null>(null);
  useEffect(() => { setFile(null); setRunId(null); }, [stage]);
  const shown = file && files.some((f) => f.path === file.path) ? file : files.find((f) => f.kind !== 'video') ?? files[0] ?? null;

  if (stage === 'approval' || stage === 'publish') {
    return (
      <div className="card p-5 text-sm text-zinc-600 dark:text-zinc-300">
        {stage === 'approval' ? (
          v.status === 'awaiting_approval' ? <>Watch the video, check the title and caption, then <b>Approve</b> to schedule it — or <b>Request changes</b> with a note and the autopilot redoes it.</>
            : v.stage === 'approval' || ['research', 'script', 'production', 'produce', 'check'].includes(v.stage) ? 'This step opens when the video passes its checks.' : 'Approved.'
        ) : v.status === 'ready_to_publish' ? <>Approved, but this project has no connected channel. <Link to="/channels" className="text-accent-600 underline">Connect a channel</Link>, link it to the project, then press <b>Publish</b>.</>
          : v.posts.length ? 'See “Posts” for each platform’s status.' : 'Posts are created after approval.'}
      </div>
    );
  }

  return (
    <>
      <LogView v={v} stage={stage} runId={activeRun?.id ?? null} live={v.running && v.stage === stage && activeRun?.id === runs.at(-1)?.id}
        runs={runs} onPickRun={setRunId} />
      {files.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex gap-1 overflow-x-auto border-b border-zinc-100 p-2 dark:border-zinc-800">
            {files.map((f) => (
              <button key={f.path} onClick={() => setFile(f)}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${shown?.path === f.path ? 'bg-zinc-100 font-medium dark:bg-zinc-800' : 'text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'}`}>
                <FileIcon kind={f.kind} />{f.path}
              </button>
            ))}
          </div>
          {shown && <ArtifactView videoId={v.id} a={shown} />}
        </div>
      )}
      {!files.length && !runs.length && <div className="card p-5 text-sm text-zinc-500">Nothing here yet.</div>}
    </>
  );
}

const FileIcon = ({ kind }: { kind: Artifact['kind'] }) => {
  const C = { video: Film, image: ImageIcon, audio: Music, markdown: FileText, json: Braces, text: FileText }[kind];
  return <C className="size-3.5" />;
};

function LogView({ v, stage, runId, live, runs, onPickRun }: { v: VideoDetail; stage: Stage; runId: number | null; live: boolean; runs: VideoDetail['runs']; onPickRun: (id: number) => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const { subscribe } = useLive();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const run = runs.find((r) => r.id === runId);

  useEffect(() => {
    setLines([]);
    if (!runId) return;
    let alive = true;
    fetch(`/api/videos/${v.id}/log/${runId}`).then((r) => r.json()).then((d) => alive && setLines(d.lines));
    return () => { alive = false; };
  }, [v.id, runId, run?.status]);
  useEffect(() => {
    if (!live) return;
    return subscribe((e) => { if (e.kind === 'log' && e.id === v.id && e.stage === stage) setLines((l) => [...l.slice(-1500), String(e.line)]); });
  }, [live, subscribe, v.id, stage]);
  useEffect(() => { if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-sm font-medium">
          Activity {live && <span className="flex items-center gap-1 text-xs font-normal text-accent-600"><span className="size-1.5 animate-pulse rounded-full bg-current" />live</span>}
        </div>
        {runs.length > 1 && (
          <select className="input h-8 w-auto py-0 text-xs" value={runId ?? ''} onChange={(e) => onPickRun(Number(e.target.value))}>
            {runs.map((r, i) => <option key={r.id} value={r.id}>Run {i + 1} · {r.status} · {fmtDate(r.started_at, { timeStyle: 'short' })}{r.cost_usd ? ` · ${usageLabel(r.cost_usd)}` : ''}</option>)}
          </select>
        )}
      </div>
      <div ref={box} onScroll={(e) => { const t = e.currentTarget; stick.current = t.scrollHeight - t.scrollTop - t.clientHeight < 40; }}
        className="max-h-80 min-h-28 overflow-y-auto bg-zinc-950 px-4 py-3 font-mono text-[12px] leading-relaxed text-zinc-300">
        {lines.length ? lines.map((l, i) => (
          <div key={i} className={`whitespace-pre-wrap break-words ${l.startsWith('▸') ? 'text-sky-300/90' : l.startsWith('✗') ? 'text-red-400' : l.startsWith('✓') ? 'text-emerald-400' : ''}`}>{l}</div>
        )) : <div className="text-zinc-500">{runId ? 'No output yet…' : 'This step has not run yet.'}</div>}
        {run?.error && <div className="mt-2 text-red-400">✗ {run.error}</div>}
      </div>
    </div>
  );
}

function ArtifactView({ videoId, a }: { videoId: number; a: Artifact }) {
  const url = fileUrl(videoId, a.path, a.mtime);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (['markdown', 'json', 'text'].includes(a.kind)) fetch(url).then((r) => r.text()).then(setText);
  }, [url, a.kind]);
  const pretty = useMemo(() => { if (a.kind !== 'json' || !text) return text; try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } }, [text, a.kind]);

  return (
    <div className="max-h-[70vh] overflow-auto p-4">
      {a.kind === 'video' && <video controls src={url} className="mx-auto max-h-[60vh] rounded-xl bg-black" />}
      {a.kind === 'image' && <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={a.path} className="mx-auto max-h-[60vh] rounded-xl" /></a>}
      {a.kind === 'audio' && <audio controls src={url} className="w-full" />}
      {a.kind === 'markdown' && text !== null && <div className="prose-sm"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>{text}</ReactMarkdown></div>}
      {(a.kind === 'json' || a.kind === 'text') && pretty !== null && <pre className="whitespace-pre-wrap break-words text-xs">{pretty}</pre>}
    </div>
  );
}

function ApproveModal({ open, onClose, v }: { open: boolean; onClose: () => void; v: VideoDetail }) {
  const [mode, setMode] = useState<'now' | 'slot' | 'custom'>('slot');
  const [vis, setVis] = useState<Visibility>(v.status === 'awaiting_approval' ? v.project.visibility ?? 'public' : v.visibility);
  useEffect(() => { if (open) setVis(v.status === 'awaiting_approval' ? v.project.visibility ?? 'public' : v.visibility); }, [open]);
  const [when, setWhen] = useState(toLocalInput(new Date(Date.now() + 3600_000).toISOString()));
  const { data: project } = useData<any>(open ? `/projects/${v.project_id}` : null);
  const { busy, run } = useAction();
  return (
    <Modal open={open} onClose={onClose} title={v.status === 'ready_to_publish' ? 'Publish video' : 'Approve video'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy === 'ok'} onClick={() => run('ok', async () => {
          if (mode === 'custom' && new Date(when).getTime() < Date.now()) throw new Error('Pick a time in the future, or choose “Publish now”.');
          await post(`/videos/${v.id}/approve`, { visibility: vis, ...(mode === 'now' ? { now: true } : mode === 'custom' ? { scheduledAt: new Date(when).toISOString() } : {}) });
          toast(mode === 'now' ? 'Publishing now — watch “Posts” for progress' : 'Approved and scheduled'); onClose();
        })}>{mode === 'now' ? 'Approve & publish now' : 'Approve & schedule'}</Button></>}>
      <div><label className="label">Visibility</label><VisibilityPicker value={vis} onChange={setVis} /></div>
      <label className="label !mb-0">When</label>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
        <input type="radio" checked={mode === 'now'} onChange={() => setMode('now')} className="mt-1" />
        <span><span className="text-sm font-medium">Publish now</span>
          <span className="block text-xs text-zinc-500">Uploads within a few seconds{vis === 'public' ? ' and goes live right away' : ''}</span></span>
      </label>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
        <input type="radio" checked={mode === 'slot'} onChange={() => setMode('slot')} className="mt-1" />
        <span><span className="text-sm font-medium">Next free posting slot</span>
          <span className="block text-xs text-zinc-500">{project?.next_slot ? fmtDate(project.next_slot, { weekday: 'long', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) : 'From the project’s posting days and times'}</span></span>
      </label>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
        <input type="radio" checked={mode === 'custom'} onChange={() => setMode('custom')} className="mt-1" />
        <span className="flex-1"><span className="text-sm font-medium">Pick a time</span>
          <input type="datetime-local" className="input mt-2" value={when} onChange={(e) => { setWhen(e.target.value); setMode('custom'); }} /></span>
      </label>
      {!v.project.channel_ids.length && <p className="text-xs text-amber-700 dark:text-amber-300">This project has no channels linked yet, so the video will wait as “ready to publish”.</p>}
    </Modal>
  );
}

function RejectModal({ open, onClose, v }: { open: boolean; onClose: () => void; v: VideoDetail }) {
  const [note, setNote] = useState('');
  const [from, setFrom] = useState<Stage | 'discard'>('produce');
  const { busy, run } = useAction();
  return (
    <Modal open={open} onClose={onClose} title="Request changes"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy === 'ok'} onClick={() => run('ok', async () => {
          if (from !== 'discard' && !note.trim()) throw new Error('Say what to change');
          await post(`/videos/${v.id}/reject`, from === 'discard' ? { note } : { note, redoFrom: from });
          toast(from === 'discard' ? 'Video rejected' : 'Sent back for changes'); onClose(); setNote('');
        })}>{from === 'discard' ? 'Reject' : 'Send back'}</Button></>}>
      <div><label className="label">What should change?</label>
        <textarea className="input min-h-28" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The hook is too slow; make captions bigger; fix the date in the second scene." /></div>
      <div><label className="label">Redo from</label>
        <select className="input" value={from} onChange={(e) => setFrom(e.target.value as any)}>
          <option value="produce">Video — keep the script, rework the film</option>
          {v.project.production_step && <option value="production">Production — keep the script, redo scenes, cast and colours</option>}
          <option value="script">Script — rewrite the script, then a new film</option>
          <option value="research">Research — pick a different topic</option>
          <option value="discard">Don’t redo — reject this video</option>
        </select></div>
    </Modal>
  );
}
