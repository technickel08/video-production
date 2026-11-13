import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useData } from '../live';
import { post, fmtDate } from '../api';
import { Button, PageHeader, PlatformIcon, useAction, toast } from '../ui';

interface Item { video_id: number; title: string; status: string; scheduled_at: string; project_name: string; posts: { platform: string; status: string; url: string | null }[]; }

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export default function Calendar() {
  const [month, setMonth] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const start = useMemo(() => { const d = new Date(month); d.setDate(1 - d.getDay()); return d; }, [month]);
  const end = useMemo(() => { const d = new Date(start); d.setDate(d.getDate() + 42); return d; }, [start]);
  const { data } = useData<Item[]>(`/calendar?from=${start.toISOString()}&to=${end.toISOString()}`);
  const { run } = useAction();
  const [drag, setDrag] = useState<Item | null>(null);
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  const today = new Date();

  const move = (item: Item, day: Date) => {
    const old = new Date(item.scheduled_at);
    const next = new Date(day); next.setHours(old.getHours(), old.getMinutes(), 0, 0);
    if (sameDay(old, next)) return;
    run('move', async () => { await post(`/videos/${item.video_id}/reschedule`, { scheduledAt: next.toISOString() }); toast(`Moved to ${fmtDate(next.toISOString())}`); });
  };

  return (
    <>
      <PageHeader title="Calendar" subtitle="Scheduled and published posts. Drag a post that hasn't been uploaded yet to move it."
        actions={<div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft className="size-4" /></Button>
          <span className="w-36 text-center text-sm font-medium">{month.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</span>
          <Button variant="ghost" size="sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight className="size-4" /></Button>
          <Button size="sm" onClick={() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); setMonth(d); }}>Today</Button>
        </div>} />
      <div className="card overflow-x-auto">
        <div className="grid min-w-[760px] grid-cols-7">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-500 dark:border-zinc-800">{d}</div>)}
          {days.map((d) => {
            const items = (data ?? []).filter((i) => sameDay(new Date(i.scheduled_at), d));
            const other = d.getMonth() !== month.getMonth();
            return (
              <div key={d.toISOString()} onDragOver={(e) => e.preventDefault()} onDrop={() => drag && move(drag, d)}
                className={`min-h-28 border-b border-r border-zinc-100 p-1.5 dark:border-zinc-800 ${other ? 'bg-zinc-50/60 dark:bg-zinc-950/40' : ''}`}>
                <div className={`mb-1 inline-grid size-6 place-items-center rounded-full text-xs ${sameDay(d, today) ? 'bg-accent-600 font-semibold text-white' : other ? 'text-zinc-400' : 'text-zinc-600 dark:text-zinc-300'}`}>{d.getDate()}</div>
                <div className="space-y-1">
                  {items.map((i) => {
                    const movable = i.posts.every((p) => p.status === 'pending' || p.status === 'failed');
                    const tone = i.status === 'published' ? 'bg-emerald-50 ring-emerald-200 dark:bg-emerald-500/10 dark:ring-emerald-500/20'
                      : i.status === 'failed' ? 'bg-red-50 ring-red-200 dark:bg-red-500/10 dark:ring-red-500/20'
                      : i.status === 'ready_to_publish' ? 'bg-teal-50 ring-teal-200 dark:bg-teal-500/10 dark:ring-teal-500/20' : 'bg-sky-50 ring-sky-200 dark:bg-sky-500/10 dark:ring-sky-500/20';
                    return (
                      <Link key={i.video_id} to={`/videos/${i.video_id}`} draggable={movable} onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)}
                        className={`block rounded-lg px-1.5 py-1 text-[11px] leading-tight ring-1 ${tone} ${movable ? 'cursor-grab' : ''}`} title={`${i.project_name}: ${i.title}`}>
                        <div className="flex items-center gap-1 text-zinc-500">
                          {fmtDate(i.scheduled_at, { hour: 'numeric', minute: '2-digit' })}
                          <span className="ml-auto flex gap-0.5">{i.posts.map((p, k) => <PlatformIcon key={k} platform={p.platform} className="size-3" />)}</span>
                        </div>
                        <div className="line-clamp-2 font-medium text-zinc-800 dark:text-zinc-100">{i.title}</div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
