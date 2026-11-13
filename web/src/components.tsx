import { Link } from 'react-router-dom';
import { Film, Check, Loader2, AlertTriangle, Hourglass, Circle } from 'lucide-react';
import { fileUrl, ago, STAGE_LABEL, stepsFor, type Video } from './api';
import { StatusBadge } from './ui';

export function Poster({ video, className = '' }: { video: Video; className?: string }) {
  const vertical = (video.aspect_ratio ?? '9:16') === '9:16' || video.aspect_ratio === '4:5';
  return (
    <div className={`relative overflow-hidden rounded-xl bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900 ${vertical ? 'aspect-[9/16]' : 'aspect-video'} ${className}`}>
      {video.has_poster
        ? <img src={fileUrl(video.id, 'poster.jpg', video.updated_at)} alt="" className="absolute inset-0 size-full object-cover" loading="lazy" />
        : <div className="absolute inset-0 grid place-items-center text-zinc-400"><Film className="size-6" /></div>}
    </div>
  );
}

export function VideoRow({ v }: { v: Video }) {
  return (
    <Link to={`/videos/${v.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
      <div className="w-10 shrink-0"><Poster video={v} className="!rounded-lg" /></div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{v.title || v.topic || `Video #${v.id}`}</div>
        <div className="truncate text-xs text-zinc-500">{v.project_name} · {STAGE_LABEL[v.stage]} · {ago(v.updated_at)}</div>
      </div>
      <StatusBadge status={v.status} />
    </Link>
  );
}

/** Compact progress dots for a video's stages. */
export function StageDots({ v }: { v: Video }) {
  const STEPS = stepsFor(v.stage === 'production' ? true : v.production_step);
  const idx = v.stage === 'done' ? STEPS.length : STEPS.indexOf(v.stage);
  return (
    <div className="flex items-center gap-1" title={STAGE_LABEL[v.stage]}>
      {STEPS.map((s, i) => {
        const done = i < idx || v.status === 'published';
        const cur = i === idx && v.status !== 'published';
        const color = done ? 'bg-emerald-500' : cur ? (v.status === 'failed' ? 'bg-red-500' : v.status === 'running' ? 'bg-accent-500 animate-pulse' : 'bg-accent-500/60') : 'bg-zinc-200 dark:bg-zinc-700';
        return <span key={s} className={`h-1.5 flex-1 rounded-full ${color}`} />;
      })}
    </div>
  );
}

export function StepIcon({ state }: { state: 'done' | 'running' | 'failed' | 'waiting' | 'todo' }) {
  const m = {
    done: <span className="grid size-6 place-items-center rounded-full bg-emerald-500 text-white"><Check className="size-3.5" /></span>,
    running: <span className="grid size-6 place-items-center rounded-full bg-accent-600 text-white"><Loader2 className="size-3.5 animate-spin" /></span>,
    failed: <span className="grid size-6 place-items-center rounded-full bg-red-500 text-white"><AlertTriangle className="size-3.5" /></span>,
    waiting: <span className="grid size-6 place-items-center rounded-full bg-amber-500 text-white"><Hourglass className="size-3.5" /></span>,
    todo: <span className="grid size-6 place-items-center rounded-full text-zinc-300 dark:text-zinc-600"><Circle className="size-5" /></span>,
  };
  return m[state];
}
