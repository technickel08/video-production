import { useEffect, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { Loader2, X, Clapperboard } from 'lucide-react';
import { STATUS_LABEL, type Status } from './api';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className = '', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  const v = {
    primary: 'bg-accent-600 text-white hover:bg-accent-700 shadow-sm',
    secondary: 'bg-white text-zinc-800 border border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800',
    ghost: 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
    danger: 'bg-white text-red-600 border border-red-200 hover:bg-red-50 dark:bg-zinc-900 dark:border-red-900/60 dark:hover:bg-red-950/40',
  }[variant];
  const s = size === 'sm' ? 'h-8 px-3 text-xs gap-1.5' : 'h-10 px-4 text-sm gap-2';
  return (
    <button {...rest} disabled={rest.disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-xl font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${v} ${s} ${className}`}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** Run an async action with a loading flag and an error toast. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); }
  };
  return { busy, run };
}

const STATUS_STYLE: Record<Status, string> = {
  queued: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  running: 'bg-accent-100 text-accent-700 dark:bg-accent-500/20 dark:text-accent-100',
  waiting_usage: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  awaiting_review: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  awaiting_approval: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  scheduled: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  ready_to_publish: 'bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300',
  published: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  archived: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  rejected: 'bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800',
};
export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}>
      {status === 'running' && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Badge({ children, tone = 'zinc' }: { children: ReactNode; tone?: 'zinc' | 'red' | 'green' | 'amber' | 'accent' }) {
  const t = {
    zinc: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
    green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
    accent: 'bg-accent-100 text-accent-700 dark:bg-accent-500/20 dark:text-accent-100',
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${t}`}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, body, action, icon }: { title: string; body?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-accent-50 text-accent-600 dark:bg-accent-500/15 dark:text-accent-100">
        {icon ?? <Clapperboard className="size-6" />}
      </div>
      <h3 className="font-semibold">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-1.5">
      <span>
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition ${checked ? 'bg-accent-600' : 'bg-zinc-300 dark:bg-zinc-700'}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-950/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={onClose}>
      <div className="card max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-b-none sm:rounded-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="size-4" /></button>
        </div>
        <div className="space-y-4 px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">{footer}</div>}
      </div>
    </div>
  );
}

// ─── Toasts ──────────────────────────────────────────────────────────────────
type T = { id: number; text: string; tone: 'ok' | 'error' };
let push: (t: T) => void = () => {};
export function toast(text: string, tone: 'ok' | 'error' = 'ok') { push({ id: Date.now() + Math.random(), text, tone }); }
export function Toasts() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    push = (t) => { setItems((x) => [...x, t]); setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), t.tone === 'error' ? 7000 : 3500); };
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div key={t.id} className={`pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-sm shadow-lg ${t.tone === 'error' ? 'bg-red-600 text-white' : 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export const PlatformIcon = ({ platform, className = 'size-4' }: { platform: string; className?: string }) =>
  platform === 'youtube' ? (
    <svg viewBox="0 0 24 24" className={className} aria-label="YouTube"><rect x="1" y="4.5" width="22" height="15" rx="4.5" fill="#FF0033" /><path d="M10 9l5.2 3L10 15z" fill="#fff" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" className={className} aria-label="Instagram">
      <defs><linearGradient id="igg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#FEDA75" /><stop offset=".4" stopColor="#D62976" /><stop offset="1" stopColor="#4F5BD5" /></linearGradient></defs>
      <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#igg)" /><circle cx="12" cy="12" r="4.2" fill="none" stroke="#fff" strokeWidth="1.8" /><circle cx="17.3" cy="6.7" r="1.2" fill="#fff" />
    </svg>
  );
