import { Link } from 'react-router-dom';
import { Check, MessageSquare, CheckCircle2, FileText, Archive } from 'lucide-react';
import { useData } from '../live';
import { post, fileUrl, ago, STAGE_LABEL, type Video } from '../api';
import { Button, PageHeader, Empty, useAction, toast } from '../ui';

export default function Approvals() {
  const { data: videos } = useData<Video[]>('/videos');
  const { busy, run } = useAction();
  if (!videos) return null;
  const list = videos.filter((v) => v.status === 'awaiting_approval');
  const steps = videos.filter((v) => v.status === 'awaiting_review');

  return (
    <>
      <PageHeader title="Approvals" subtitle="Steps and finished videos waiting for you. Approve a step to start the next one; approve a video to schedule it." />
      {!!steps.length && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-zinc-500">Steps to review</h2>
          <div className="card divide-y divide-zinc-100 dark:divide-zinc-800">
            {steps.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-3 p-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300"><FileText className="size-4" /></span>
                <Link to={`/videos/${v.id}`} className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium hover:text-accent-600">{v.title || v.topic || `Video #${v.id}`}</div>
                  <div className="text-xs text-zinc-500">{v.project_name} · <b>{STAGE_LABEL[v.stage]}</b> ready {ago(v.updated_at)}</div>
                </Link>
                <Link to={`/videos/${v.id}`}><Button size="sm" icon={<MessageSquare className="size-4" />}>Read</Button></Link>
                <Button size="sm" variant="primary" icon={<Check className="size-4" />} loading={busy === `c${v.id}`}
                  onClick={() => run(`c${v.id}`, async () => { await post(`/videos/${v.id}/continue`); toast(`${STAGE_LABEL[v.stage]} approved`); })}>Approve</Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {!!steps.length && !!list.length && <h2 className="mb-2 text-sm font-semibold text-zinc-500">Finished videos</h2>}
      {!list.length ? !steps.length && <Empty icon={<CheckCircle2 className="size-6" />} title="All caught up" body="New videos show up here when they're ready for your review." /> : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((v) => (
            <div key={v.id} className="card flex flex-col overflow-hidden">
              <video controls playsInline preload="metadata" poster={fileUrl(v.id, 'poster.jpg', v.updated_at)} src={fileUrl(v.id, 'final.mp4', v.updated_at)}
                className={`w-full bg-black ${v.aspect_ratio === '9:16' ? 'aspect-[9/16] max-h-[520px]' : 'aspect-video'}`} />
              <div className="flex flex-1 flex-col p-4">
                <Link to={`/videos/${v.id}`} className="font-semibold leading-snug hover:text-accent-600">{v.title}</Link>
                <div className="mt-1 text-xs text-zinc-500">{v.project_name} · ready {ago(v.updated_at)}</div>
                <div className="mt-auto flex gap-2 pt-4">
                  <Button variant="primary" className="flex-1" icon={<Check className="size-4" />} loading={busy === `a${v.id}`}
                    onClick={() => run(`a${v.id}`, async () => { await post(`/videos/${v.id}/approve`); toast('Approved and scheduled'); })}>Approve</Button>
                  <Link to={`/videos/${v.id}`}><Button icon={<MessageSquare className="size-4" />}>Review</Button></Link>
                  <Button icon={<Archive className="size-4" />} title="Archive for later" loading={busy === `x${v.id}`}
                    onClick={() => run(`x${v.id}`, async () => { await post(`/videos/${v.id}/archive`); toast('Archived — find it in Pipeline → Show archived'); })} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
