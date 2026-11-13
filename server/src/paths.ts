import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const DATA_DIR = process.env.VA_DATA_DIR ? path.resolve(process.env.VA_DATA_DIR) : path.join(ROOT, 'data');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const PROMPTS_DIR = path.join(ROOT, 'prompts');
export const SKILL_DIR = path.join(ROOT, 'skills', 'lemo-opuscar');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');
export const LIB_DIR = process.env.LEMO_OPUSCAR_HOME || path.join(os.homedir(), 'lemo-opuscar');
export const PORT = Number(process.env.PORT || 4317);
export const BASE_URL = `http://localhost:${PORT}`;

fs.mkdirSync(PROJECTS_DIR, { recursive: true });

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
}

export function videoDir(projectId: number, videoId: number) {
  return path.join(PROJECTS_DIR, `p${projectId}`, `v${videoId}`);
}
