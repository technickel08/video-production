import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../live';
import { ago, type Video, type Project, type Stage } from '../api';
import { PageHeader, StatusBadge, Empty } from '../ui';
import { Poster } from '../components';

const COLUMNS: { stage: Stage; label: string }[] = [
  { stage: 'research', label: 'Research' },
  { stage: 'script', label: 'Script' },
  { stage: 'production', label: 'Production' },
  { stage: 'produce', label: 'Video' },
  { stage: 'check', label: 'Check' },
  { stage: 'approval', label: 'Approval' },
  { stage: 'publish', label: 'Scheduled' },
  { stage: 'done', label: 'Published' },
];

export default function Pipeline() {
  const [project, setProject] = useState('');
  const [showRejected, setShowRejected] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const { data: videos } = useData<Video[]>(`/videos${project ? `?project=${project}` : ''}`);
  const { data: projects } = useData<Project[]>('/projects');
  if (!videos) return null;
  const archivedCount = videos.filter((v) => v.status === 'archived').length;
  const list = videos.filter((v) => (showRejected || v.status !== 'rejected') && (showArchived || v.status !== 'archived'));

  return (
    <>
      <PageHeader title="Pipeline" subtitle="Every video, live, by step."
        actions={<>
          <select className="input w-auto" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-zinc-500"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived{archivedCount ? ` (${archivedCount})` : ''}</label>
          <label className="flex items-center gap-2 text-xs text-zinc-500"><input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />Show rejected</label>
        </>} />
      {!list.length ? <Empty title="Nothing in the pipeline" body="Open a project and press “Make a video now”, or turn on its autopilot." /> : (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-8 sm:px-8">
          <div className="grid min-w-[1280px] grid-cols-8 gap-3">
            {COLUMNS.map((col) => {
              const items = list.filter((v) => v.stage === col.stage);
              return (
                <div key={col.stage} className="rounded-2xl bg-zinc-100/70 p-2 dark:bg-zinc-900/60">
                  <div className="flex items-center justify-between px-2 pb-2 pt-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{col.label}</span>
                    <span className="text-xs tabular-nums text-zinc-400">{items.length}</span>
                  </div>
                  <div className="space-y-2">
                    {items.map((v) => (
                      <Link key={v.id} to={`/videos/${v.id}`} className={`card block p-2.5 transition hover:-translate-y-0.5 hover:shadow-md ${v.status === 'failed' ? 'ring-1 ring-red-300 dark:ring-red-500/40' : ''}`}>
                        {v.has_poster && <Poster video={v} className="mb-2 !aspect-video" />}
                        <div className="line-clamp-2 text-[13px] font-medium leading-snug">{v.title || v.topic || `Video #${v.id}`}</div>
                        <div className="mt-1 truncate text-[11px] text-zinc-500">{v.project_name} · {ago(v.updated_at)}</div>
                        <div className="mt-2"><StatusBadge status={v.status} /></div>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
