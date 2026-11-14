import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Brain, Puzzle, Sparkles, Check, X, Undo2, Plus, Info } from 'lucide-react';
import { useData } from '../live';
import { post, ago, type Note } from '../api';
import { Button, PageHeader, Empty, useAction, toast } from '../ui';

const ICON: Record<string, React.ReactNode> = {
  playbook: <Brain className="size-4" />, proposal: <Sparkles className="size-4" />, applied: <Check className="size-4" />,
  skill_found: <Puzzle className="size-4" />, skill_added: <Plus className="size-4" />, scout: <Puzzle className="size-4" />, info: <Info className="size-4" />,
};

export default function Inbox() {
  const { data: notes, reload } = useData<Note[]>('/notifications');
  const { busy, run } = useAction();
  // Opening the feed marks everything as read (after a moment, so new items still stand out).
  useEffect(() => { const t = setTimeout(() => { void post('/notifications/read'); }, 1500); return () => clearTimeout(t); }, [notes?.[0]?.id]);
  if (!notes) return null;

  const act = (key: string, path: string, msg: string) => run(key, async () => { await post(path); toast(msg); reload(); });
  const actions = (n: Note) => {
    const [kind, id] = (n.ref ?? '').split(':');
    if (kind === 'proposal' && n.state === 'pending') return <>
      <Button size="sm" variant="primary" icon={<Check className="size-4" />} loading={busy === `a${n.id}`} onClick={() => act(`a${n.id}`, `/proposals/${id}/approve`, 'Change applied')}>Approve</Button>
      <Button size="sm" icon={<X className="size-4" />} loading={busy === `d${n.id}`} onClick={() => act(`d${n.id}`, `/proposals/${id}/dismiss`, 'Dismissed')}>Dismiss</Button>
    </>;
    if (kind === 'proposal' && n.state === 'applied') return <Button size="sm" icon={<Undo2 className="size-4" />} loading={busy === `u${n.id}`} onClick={() => act(`u${n.id}`, `/proposals/${id}/undo`, 'Change undone')}>Undo</Button>;
    if (kind === 'skill' && n.state === 'found') return <>
      <Button size="sm" variant="primary" icon={<Plus className="size-4" />} loading={busy === `i${n.id}`} onClick={() => act(`i${n.id}`, `/skills/${id}/install`, 'Skill added')}>Add</Button>
      <Button size="sm" icon={<X className="size-4" />} loading={busy === `x${n.id}`} onClick={() => act(`x${n.id}`, `/skills/${id}/dismiss`, 'Dismissed')}>Dismiss</Button>
    </>;
    if (n.state && n.state !== 'pending' && n.state !== 'found') return <span className="text-xs text-zinc-400">{n.state === 'installed' ? 'Added' : n.state[0].toUpperCase() + n.state.slice(1)}</span>;
    return null;
  };

  return (
    <>
      <PageHeader title="What's new" subtitle="What the system learned, changed or found. Approve or undo changes right here." />
      {!notes.length ? <Empty icon={<Bell className="size-6" />} title="Nothing yet" body="Lessons, proposed changes and new skills show up here." /> : (
        <div className="card divide-y divide-zinc-100 dark:divide-zinc-800">
          {notes.map((n) => (
            <div key={n.id} className={`flex flex-wrap items-start gap-3 p-4 ${n.read_at ? '' : 'bg-accent-50/50 dark:bg-accent-500/5'}`}>
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{ICON[n.kind] ?? <Info className="size-4" />}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {n.link ? <Link to={n.link} className="font-medium hover:text-accent-600">{n.title}</Link> : <span className="font-medium">{n.title}</span>}
                  <span className="text-xs text-zinc-400">{ago(n.created_at)}</span>
                </div>
                {n.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">{n.body}</p>}
              </div>
              <div className="flex items-center gap-2">{actions(n)}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
