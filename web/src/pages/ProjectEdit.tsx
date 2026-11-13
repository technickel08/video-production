import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Plus, X, Trash2, Sparkles, Search, Play, Loader2 } from 'lucide-react';
import { useData } from '../live';
import { api, post, put, del, VISIBILITY, type Project, type Channel, type Style, type Video, type Voice, type Insight } from '../api';
import { Button, Section, Toggle, useAction, toast, PlatformIcon } from '../ui';
import { VideoRow } from '../components';

const FORMATS = [
  { id: 'Short', label: 'Short / Reel', aspect: '9:16', duration: 45, hint: 'Vertical · YouTube Shorts & Instagram Reels' },
  { id: 'Video', label: 'YouTube video', aspect: '16:9', duration: 240, hint: 'Horizontal · long-form' },
  { id: 'Square', label: 'Square post', aspect: '1:1', duration: 30, hint: 'Feeds' },
  { id: 'Portrait', label: 'Portrait post', aspect: '4:5', duration: 30, hint: 'Instagram feed' },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EMPTY: Partial<Project> = {
  name: '', niche: '', audience: '', language: 'English', format: 'Short', duration_sec: 45, aspect_ratio: '9:16', styles: [],
  voice: true, music: true, captions: true, notes: '', post_times: ['18:00'], post_days: [0, 1, 2, 3, 4, 5, 6], daily_cap: 1,
  autopilot: false, auto_publish: false, active: true, channel_ids: [], visibility: 'public',
  voice_name: '', voice_speed: 0, voice_style: '', music_mood: '', production_step: true, review_steps: true,
};

export default function ProjectEdit() {
  const { id } = useParams();
  const isNew = !id;
  const nav = useNavigate();
  const [p, setP] = useState<Partial<Project> | null>(isNew ? EMPTY : null);
  const { data: channels } = useData<Channel[]>('/channels');
  const { data: styles } = useData<Style[]>('/styles');
  const { data: videos } = useData<Video[]>(isNew ? null : `/videos?project=${id}`);
  const { busy, run } = useAction();
  const [newTime, setNewTime] = useState('12:00');
  const [styleQuery, setStyleQuery] = useState('');

  useEffect(() => { if (!isNew) api<Project>(`/projects/${id}`).then(setP, (e) => toast(e.message, 'error')); }, [id, isNew]);
  const set = <K extends keyof Project>(k: K, v: Project[K]) => setP((x) => ({ ...x!, [k]: v }));

  const grouped = useMemo(() => {
    const q = styleQuery.toLowerCase();
    const m = new Map<string, Style[]>();
    for (const s of styles ?? []) if (!q || s.name.toLowerCase().includes(q) || s.slug.includes(q) || s.category.toLowerCase().includes(q)) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return [...m];
  }, [styles, styleQuery]);

  if (!p) return null;
  const save = () => run('save', async () => {
    if (!p.name?.trim()) throw new Error('Give the project a name');
    if (!p.niche?.trim()) throw new Error('Describe the niche — research depends on it');
    const saved = isNew ? await post<Project>('/projects', p) : await put<Project>(`/projects/${id}`, p);
    toast('Project saved');
    if (isNew) nav(`/projects/${saved.id}`, { replace: true });
  });

  return (
    <>
      <Link to="/projects" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-white"><ArrowLeft className="size-4" />Projects</Link>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{isNew ? 'New project' : p.name}</h1>
        <div className="flex gap-2">
          {!isNew && <Button icon={<Sparkles className="size-4" />} loading={busy === 'run'}
            onClick={() => run('run', async () => { const v = await post(`/projects/${id}/run`); nav(`/videos/${v.id}`); })}>Make a video now</Button>}
          <Button variant="primary" loading={busy === 'save'} onClick={save}>{isNew ? 'Create project' : 'Save changes'}</Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Section title="Basics" description="What the channel is about. Research and scripts follow this.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2"><label className="label">Project name</label><input className="input" value={p.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Space Facts Daily" /></div>
              <div className="sm:col-span-2"><label className="label">Niche / topic area</label><textarea className="input min-h-20" value={p.niche} onChange={(e) => set('niche', e.target.value)} placeholder="e.g. Astronomy and space exploration news, explained simply" /></div>
              <div><label className="label">Audience</label><input className="input" value={p.audience} onChange={(e) => set('audience', e.target.value)} placeholder="e.g. Curious teens and adults" /></div>
              <div><label className="label">Language</label><input className="input" value={p.language} onChange={(e) => set('language', e.target.value)} list="langs" />
                <datalist id="langs">{['English', 'Hindi', 'Spanish', 'Portuguese', 'French', 'German', 'Japanese', 'Chinese'].map((l) => <option key={l} value={l} />)}</datalist></div>
              <div className="sm:col-span-2"><label className="label">Extra instructions (optional)</label><textarea className="input min-h-16" value={p.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Tone, things to avoid, recurring sign-off…" /></div>
            </div>
          </Section>

          <Section title="Format">
            <div className="grid gap-2 sm:grid-cols-2">
              {FORMATS.map((f) => (
                <button key={f.id} type="button" onClick={() => setP((x) => ({ ...x!, format: f.id, aspect_ratio: f.aspect, duration_sec: x!.format === f.id ? x!.duration_sec : f.duration }))}
                  className={`rounded-xl border p-3 text-left transition ${p.format === f.id ? 'border-accent-500 bg-accent-50 ring-4 ring-accent-500/10 dark:bg-accent-500/10' : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700'}`}>
                  <div className="text-sm font-medium">{f.label} <span className="text-zinc-400">· {f.aspect}</span></div>
                  <div className="text-xs text-zinc-500">{f.hint}</div>
                </button>
              ))}
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div><label className="label">Length: {p.duration_sec}s</label>
                <input type="range" min={10} max={p.format === 'Video' ? 900 : 180} step={5} value={p.duration_sec} onChange={(e) => set('duration_sec', Number(e.target.value))} className="w-full accent-[var(--color-accent-600)]" /></div>
              <div><label className="label">Aspect ratio</label>
                <select className="input" value={p.aspect_ratio} onChange={(e) => set('aspect_ratio', e.target.value)}>{['9:16', '16:9', '1:1', '4:5'].map((a) => <option key={a}>{a}</option>)}</select></div>
            </div>
          </Section>

          <Section title="Visual style" description={p.styles!.length ? `${p.styles!.length} selected — the script picks the best fit for each video.` : 'None selected — the script picks any style that fits each topic.'}
            actions={p.styles!.length ? <Button size="sm" variant="ghost" onClick={() => set('styles', [])}>Clear</Button> : undefined}>
            <div className="relative mb-3"><Search className="absolute left-3 top-2.5 size-4 text-zinc-400" /><input className="input pl-9" placeholder="Search styles" value={styleQuery} onChange={(e) => setStyleQuery(e.target.value)} /></div>
            {!styles?.length && <p className="text-sm text-zinc-500">The style library isn't downloaded yet — install video tools in Settings.</p>}
            <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
              {grouped.map(([cat, list]) => (
                <div key={cat}>
                  <div className="mb-1.5 text-xs font-medium text-zinc-500">{cat}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((s) => {
                      const on = p.styles!.includes(s.slug);
                      return <button key={s.slug} type="button" onClick={() => set('styles', on ? p.styles!.filter((x) => x !== s.slug) : [...p.styles!, s.slug])}
                        className={`rounded-full px-3 py-1 text-xs transition ${on ? 'bg-accent-600 text-white' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300'}`}>{s.name}</button>;
                    })}
                  </div>
                </div>
              ))}
            </div>
            <a href="https://lemomo-ai.github.io/lemo-opuscar/" target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-accent-600 underline">See every style's demo film</a>
          </Section>

          <Section title="Sound">
            <Toggle checked={!!p.voice} onChange={(v) => set('voice', v)} label="AI voiceover" hint="Narration generated from the script" />
            {p.voice && <VoiceSettings p={p} set={set} />}
            <Toggle checked={!!p.music} onChange={(v) => set('music', v)} label="Background music" />
            {p.music && <div className="mb-2 ml-1 border-l-2 border-zinc-100 pl-4 dark:border-zinc-800">
              <label className="label">Music mood</label>
              <input className="input" list="music-moods" value={p.music_mood ?? ''} onChange={(e) => set('music_mood', e.target.value)} placeholder="Let Claude choose" />
              <datalist id="music-moods">{MOODS.map((m) => <option key={m} value={m} />)}</datalist></div>}
            <Toggle checked={!!p.captions} onChange={(v) => set('captions', v)} label="Burned-in captions" />
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="Publishing">
            <label className="label">Channels</label>
            <div className="space-y-1.5">
              {channels?.length ? channels.map((c) => {
                const on = p.channel_ids!.includes(c.id);
                return (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700">
                    <input type="checkbox" checked={on} onChange={() => set('channel_ids', on ? p.channel_ids!.filter((x) => x !== c.id) : [...p.channel_ids!, c.id])} className="accent-[var(--color-accent-600)]" />
                    <PlatformIcon platform={c.platform} /> <span className="truncate">{c.name}</span>
                  </label>
                );
              }) : <p className="text-sm text-zinc-500">No channels connected yet. <Link to="/channels" className="text-accent-600 underline">Connect one</Link> — until then approved videos wait as “ready to publish”.</p>}
            </div>

            <label className="label mt-5">Posting days</label>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d, i) => {
                const on = p.post_days!.includes(i);
                return <button key={d} type="button" onClick={() => set('post_days', on ? p.post_days!.filter((x) => x !== i) : [...p.post_days!, i].sort())}
                  className={`h-8 w-11 rounded-lg text-xs font-medium ${on ? 'bg-accent-600 text-white' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800'}`}>{d}</button>;
              })}
            </div>

            <label className="label mt-5">Posting times</label>
            <div className="flex flex-wrap gap-1.5">
              {p.post_times!.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-1 pl-3 pr-1.5 text-xs dark:bg-zinc-800">{t}
                  <button onClick={() => set('post_times', p.post_times!.filter((x) => x !== t))} className="rounded-full p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700"><X className="size-3" /></button></span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input type="time" className="input" value={newTime} onChange={(e) => setNewTime(e.target.value)} />
              <Button icon={<Plus className="size-4" />} onClick={() => newTime && !p.post_times!.includes(newTime) && set('post_times', [...p.post_times!, newTime].sort())}>Add</Button>
            </div>

            <label className="label mt-5">Default visibility</label>
            <VisibilityPicker value={p.visibility ?? 'public'} onChange={(v) => set('visibility', v)} />

            <div className="mt-5"><label className="label">Videos per day (max)</label>
              <input type="number" min={1} max={10} className="input" value={p.daily_cap} onChange={(e) => set('daily_cap', Math.max(1, Number(e.target.value)))} /></div>
          </Section>

          <Section title="Automation">
            <Toggle checked={!!p.autopilot} onChange={(v) => set('autopilot', v)} label="Autopilot" hint="Start new videos by itself, up to the daily maximum" />
            <Toggle checked={!!p.production_step} onChange={(v) => set('production_step', v)} label="Production design step" hint="Before the film is made, Claude plans scenes, cast, costumes, sets and colours" />
            <Toggle checked={!!p.review_steps} onChange={(v) => set('review_steps', v)} label="Review each step" hint={`Pause after research, script${p.production_step ? ' and production' : ''} until you approve or ask for changes`} />
            <Toggle checked={!!p.auto_publish} onChange={(v) => set('auto_publish', v)} label="Skip final approval" hint="Schedule videos as soon as they pass checks" />
            <Toggle checked={!!p.active} onChange={(v) => set('active', v)} label="Project active" />
          </Section>

          {!isNew && (
            <Button variant="danger" className="w-full" icon={<Trash2 className="size-4" />} loading={busy === 'del'}
              onClick={() => confirm(`Delete “${p.name}” and all its videos and files?`) && run('del', async () => { await del(`/projects/${id}`); toast('Project deleted'); nav('/projects'); })}>
              Delete project
            </Button>
          )}
        </div>
      </div>

      {!isNew && <WhatWorks id={id!} />}
      {!isNew && (
        <section className="card mt-4 p-4">
          <h2 className="mb-2 px-2 font-semibold">Videos</h2>
          {videos?.length ? videos.map((v) => <VideoRow key={v.id} v={{ ...v, project_name: p.name }} />) : <p className="px-2 py-4 text-sm text-zinc-500">No videos yet.</p>}
        </section>
      )}
    </>
  );
}

function WhatWorks({ id }: { id: string }) {
  const { data } = useData<Insight[]>(`/projects/${id}/insights`);
  if (!data) return null;
  const enough = data.length >= 5;
  const max = Math.max(1, ...data.map((d) => d.views));
  return (
    <section className="card mt-4 p-4">
      <div className="mb-2 px-2"><h2 className="font-semibold">What's working</h2>
        <p className="text-xs text-zinc-500">{enough ? 'Claude reads the best and weakest of these before picking topics and writing hooks.'
          : `Claude starts learning from results after 5 published videos with at least a day of stats (${data.length} so far).`}</p></div>
      {data.slice(0, 8).map((d) => (
        <Link key={d.id} to={`/videos/${d.id}`} className="block rounded-lg px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
          <div className="flex items-baseline justify-between gap-3 text-sm"><span className="truncate">{d.title}</span>
            <span className="shrink-0 text-xs text-zinc-500">{d.views.toLocaleString()} views · {d.likes} likes{d.hook_score != null ? ` · hook ${d.hook_score}/10` : ''}</span></div>
          <div className="mt-1 h-1 rounded-full bg-zinc-100 dark:bg-zinc-800"><div className="h-1 rounded-full bg-accent-500" style={{ width: `${Math.max(2, (d.views / max) * 100)}%` }} /></div>
        </Link>
      ))}
    </section>
  );
}

const MOODS = ['Epic and cinematic', 'Mysterious and dark', 'Calm and reflective', 'Upbeat and energetic', 'Tense, building suspense', 'Traditional Indian instruments', 'Light and playful', 'Minimal ambient'];
const SPEEDS = [{ v: 0, label: 'Auto' }, { v: 0.85, label: 'Slow' }, { v: 0.92, label: 'Relaxed' }, { v: 1, label: 'Normal' }, { v: 1.1, label: 'Fast' }];
const DELIVERY = ['Calm documentary narrator', 'Dramatic storyteller, builds suspense', 'Energetic and punchy', 'Warm and conversational', 'Serious news anchor'];

function VoiceSettings({ p, set }: { p: Partial<Project>; set: <K extends keyof Project>(k: K, v: Project[K]) => void }) {
  const { data: voices } = useData<Voice[]>('/voices');
  const [playing, setPlaying] = useState<'loading' | 'playing' | null>(null);
  const audio = useMemo(() => new Audio(), []);
  useEffect(() => () => audio.pause(), [audio]);
  const groups = useMemo(() => {
    const m = new Map<string, Voice[]>();
    for (const v of voices ?? []) m.set(v.accent, [...(m.get(v.accent) ?? []), v]);
    return [...m];
  }, [voices]);
  async function preview() {
    if (!p.voice_name) return;
    setPlaying('loading');
    try {
      const r = await fetch(`/api/voices/${p.voice_name}/preview?speed=${p.voice_speed || 0}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Preview failed');
      audio.src = URL.createObjectURL(await r.blob());
      audio.onended = () => setPlaying(null);
      await audio.play(); setPlaying('playing');
    } catch (e: any) { toast(e.message, 'error'); setPlaying(null); }
  }
  return (
    <div className="mb-2 ml-1 space-y-3 border-l-2 border-zinc-100 pl-4 dark:border-zinc-800">
      <div><label className="label">Narrator voice</label>
        <div className="flex gap-2">
          <select className="input" value={p.voice_name ?? ''} onChange={(e) => { audio.pause(); setPlaying(null); set('voice_name', e.target.value); }}>
            <option value="">Let Claude choose for each video</option>
            {groups.map(([accent, list]) => <optgroup key={accent} label={accent}>
              {list.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.gender}{v.hint ? ` · ${v.hint}` : ''}</option>)}
            </optgroup>)}
          </select>
          <Button disabled={!p.voice_name || playing === 'loading'} onClick={() => playing === 'playing' ? (audio.pause(), setPlaying(null)) : preview()}
            icon={playing === 'loading' ? <Loader2 className="size-4 animate-spin" /> : playing === 'playing' ? <X className="size-4" /> : <Play className="size-4" />}>
            {playing === 'playing' ? 'Stop' : 'Listen'}</Button>
        </div>
        {p.voice_name && p.language && !voices?.find((v) => v.id === p.voice_name)?.accent.toLowerCase().includes(p.language.toLowerCase().split(' ')[0]) &&
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">This voice speaks {voices?.find((v) => v.id === p.voice_name)?.accent}, but the project language is {p.language}.</p>}</div>
      <div><label className="label">Speaking speed</label>
        <div className="flex flex-wrap gap-1.5">
          {SPEEDS.map((s) => <button key={s.v} type="button" onClick={() => set('voice_speed', s.v)}
            className={`rounded-full px-3 py-1 text-xs transition ${(p.voice_speed ?? 0) === s.v ? 'bg-accent-600 text-white' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300'}`}>{s.label}</button>)}
        </div></div>
      <div><label className="label">Delivery</label>
        <input className="input" list="voice-delivery" value={p.voice_style ?? ''} onChange={(e) => set('voice_style', e.target.value)} placeholder="e.g. Calm documentary narrator" />
        <datalist id="voice-delivery">{DELIVERY.map((d) => <option key={d} value={d} />)}</datalist>
        <p className="mt-1 text-xs text-zinc-500">Shapes how the script is written for the voice — pauses, emphasis, sentence length.</p></div>
    </div>
  );
}

export function VisibilityPicker({ value, onChange }: { value: Project['visibility']; onChange: (v: Project['visibility']) => void }) {
  return (
    <div>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800">
        {VISIBILITY.map((o) => (
          <button key={o.id} type="button" onClick={() => onChange(o.id)}
            className={`rounded-lg py-1.5 text-xs font-medium transition ${value === o.id ? 'bg-white shadow-sm dark:bg-zinc-950' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'}`}>{o.label}</button>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-zinc-500">{VISIBILITY.find((o) => o.id === value)?.hint}{value !== 'public' && '. Instagram only posts public Reels, so it is skipped.'}</p>
    </div>
  );
}
