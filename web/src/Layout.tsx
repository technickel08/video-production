import { NavLink, Outlet, Link } from 'react-router-dom';
import { LayoutDashboard, FolderKanban, Columns3, CheckCircle2, CalendarDays, Plug, Settings, Play, Pause, FlaskConical, LogOut } from 'lucide-react';
import { useData, useLive } from './live';
import { put, post } from './api';
import { useAction } from './ui';

const NAV = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/pipeline', label: 'Pipeline', icon: Columns3 },
  { to: '/approvals', label: 'Approvals', icon: CheckCircle2, badge: 'awaiting' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/channels', label: 'Channels', icon: Plug },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

export function Layout() {
  const { data: o } = useData<any>('/overview');
  const { data: me } = useData<{ required: boolean; user: { email: string; role: string } | null }>('/auth/me');
  const nav = NAV.filter((n) => n.to !== '/settings' || !me?.required || me.user?.role === 'admin');
  const { connected } = useLive();
  const { busy, run } = useAction();
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition ${isActive
      ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-white dark:ring-zinc-700'
      : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white'}`;

  return (
    <div className="min-h-screen lg:flex">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-zinc-200/70 px-3 py-5 lg:flex dark:border-zinc-800">
        <Link to="/" className="mb-7 flex items-center gap-2.5 px-2">
          <span className="grid size-8 place-items-center rounded-xl bg-accent-600 text-white shadow-sm"><Play className="size-4 fill-current" /></span>
          <span className="font-semibold tracking-tight">Video Autopilot</span>
        </Link>
        <nav className="flex flex-col gap-1">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={'end' in n} className={link}>
              <n.icon className="size-4" />
              <span className="flex-1">{n.label}</span>
              {'badge' in n && o?.awaiting > 0 && <span className="rounded-full bg-orange-500 px-1.5 text-[11px] font-semibold text-white">{o.awaiting}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-2 px-1">
          {o?.mock && <div className="flex items-center gap-2 rounded-xl bg-amber-100 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"><FlaskConical className="size-3.5" />Test mode</div>}
          <button onClick={() => run('pause', () => put('/settings', { paused: !o?.paused }))} disabled={busy === 'pause'}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900">
            {o?.paused ? <><Play className="size-3.5" />Resume automation</> : <><Pause className="size-3.5" />Pause automation</>}
          </button>
          {me?.required && me.user && (
            <button onClick={() => run('logout', async () => { await post('/auth/logout'); window.location.assign('/login'); })} title="Sign out"
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900">
              <LogOut className="size-3.5 shrink-0" /><span className="truncate">Sign out · {me.user.role === 'admin' ? 'Admin' : me.user.email}</span>
            </button>
          )}
          <div className="flex items-center gap-2 px-3 text-[11px] text-zinc-400">
            <span className={`size-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-zinc-400'}`} />{connected ? 'Live' : 'Reconnecting…'}
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 border-b border-zinc-200/70 bg-zinc-50/90 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="grid size-7 place-items-center rounded-lg bg-accent-600 text-white"><Play className="size-3.5 fill-current" /></span>
          <span className="font-semibold">Video Autopilot</span>
          {o?.mock && <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">Test mode</span>}
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={'end' in n}
              className={({ isActive }) => `flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${isActive ? 'bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700' : 'text-zinc-500'}`}>
              <n.icon className="size-3.5" />{n.label}
              {'badge' in n && o?.awaiting > 0 && <span className="rounded-full bg-orange-500 px-1 text-[10px] text-white">{o.awaiting}</span>}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 lg:py-8">
        <div className="mx-auto max-w-7xl"><Outlet /></div>
      </main>
    </div>
  );
}
