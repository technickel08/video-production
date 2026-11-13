import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';

const pexec = promisify(execFile);

function which(cmd: string): string | null {
  try { return execFileSync('/bin/sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

/** PATH for child processes: the login shell's PATH (Homebrew etc.), then bundled ffmpeg as a fallback. */
let cachedPath: string | null = null;
export function toolPath(): string {
  if (cachedPath) return cachedPath;
  let p = process.env.PATH || '';
  try { p = execFileSync('/bin/sh', ['-lc', 'echo $PATH'], { encoding: 'utf8' }).trim() || p; } catch {}
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'];
  const fallback = [ffmpegStatic].filter(Boolean).map((f) => path.dirname(f as unknown as string));
  cachedPath = [...new Set([...p.split(':'), ...extra, ...fallback])].join(':');
  return cachedPath;
}

export const ffmpegBin = () => which('ffmpeg') || (ffmpegStatic as unknown as string);
export const systemFfmpeg = () => which('ffmpeg');
export { which };

export interface Probe { duration: number; width: number | null; height: number | null; hasAudio: boolean; }

/** Duration, size and audio presence. Uses ffprobe when installed, else parses `ffmpeg -i` (bundled ffmpeg). */
export async function probe(file: string): Promise<Probe> {
  const fp = which('ffprobe');
  if (fp) {
    const { stdout } = await pexec(fp, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    const j = JSON.parse(stdout);
    const v = j.streams.find((s: any) => s.codec_type === 'video');
    return { duration: Number(j.format.duration), width: v?.width ?? null, height: v?.height ?? null, hasAudio: j.streams.some((s: any) => s.codec_type === 'audio') };
  }
  const out: string = await pexec(ffmpegBin(), ['-hide_banner', '-i', file]).then((r) => r.stderr, (e) => e.stderr ?? '');
  const d = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const v = out.match(/Stream #.*Video:.*?[ ,](\d{2,5})x(\d{2,5})[ ,\[]/);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    width: v ? Number(v[1]) : null, height: v ? Number(v[2]) : null, hasAudio: /Stream #.*Audio:/.test(out),
  };
}

export async function ffmpeg(args: string[], timeout = 10 * 60_000) {
  return pexec(ffmpegBin(), ['-hide_banner', '-y', ...args], { timeout, maxBuffer: 50 * 1024 * 1024 });
}

/** Integrated loudness in LUFS, or null if it can't be measured. */
export async function loudness(file: string): Promise<number | null> {
  try {
    const { stderr } = await pexec(ffmpegBin(), ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { maxBuffer: 50 * 1024 * 1024, timeout: 5 * 60_000 });
    const m = [...stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

export const exists = (p: string) => { try { fs.accessSync(p); return true; } catch { return false; } };
