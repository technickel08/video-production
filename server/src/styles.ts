import fs from 'node:fs';
import path from 'node:path';
import { LIB_DIR } from './paths.ts';

export interface Style { slug: string; name: string; category: string; }

let cache: Style[] | null = null;

/** Styles from the Lemo-Opuscar library's index (styles/README.md). */
export function listStyles(): Style[] {
  if (cache) return cache;
  const file = path.join(LIB_DIR, 'styles', 'README.md');
  if (!fs.existsSync(file)) return [];
  const out: Style[] = [];
  let category = '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const h = line.match(/^##\s+(.+?)(?:\s+·.*)?$/);
    if (h) { category = h[1].trim(); continue; }
    const r = line.match(/^\|\s*([^|]+?)\s*\|\s*[^|]*\|\s*\[`([a-z0-9-]+)`\]/);
    if (r && category) out.push({ name: r[1], slug: r[2], category });
  }
  cache = out;
  return out;
}

export function styleListText(allowed: string[]): string {
  const styles = listStyles().filter((s) => !allowed.length || allowed.includes(s.slug));
  if (!styles.length) return allowed.length ? allowed.map((s) => `- ${s}`).join('\n') : '- choose any style from the library';
  return styles.map((s) => `- \`${s.slug}\` — ${s.name} (${s.category})`).join('\n');
}
