import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR, LIB_DIR } from './paths.ts';

/** Narrator voices of the skill's offline engine (Kokoro). `lang` is the engine's language code. */
export interface Voice { id: string; name: string; gender: 'Female' | 'Male'; accent: string; lang: string; hint?: string }

const v = (id: string, name: string, gender: Voice['gender'], accent: string, lang: string, hint?: string): Voice => ({ id, name, gender, accent, lang, hint });
export const VOICES: Voice[] = [
  v('am_michael', 'Michael', 'Male', 'American English', 'en-us', 'warm storyteller'),
  v('am_adam', 'Adam', 'Male', 'American English', 'en-us', 'deep'),
  v('am_onyx', 'Onyx', 'Male', 'American English', 'en-us', 'low, serious'),
  v('am_fenrir', 'Fenrir', 'Male', 'American English', 'en-us', 'strong'),
  v('am_eric', 'Eric', 'Male', 'American English', 'en-us'),
  v('am_liam', 'Liam', 'Male', 'American English', 'en-us', 'young'),
  v('am_echo', 'Echo', 'Male', 'American English', 'en-us'),
  v('am_puck', 'Puck', 'Male', 'American English', 'en-us', 'playful'),
  v('af_heart', 'Heart', 'Female', 'American English', 'en-us', 'natural, warm'),
  v('af_bella', 'Bella', 'Female', 'American English', 'en-us', 'expressive'),
  v('af_nicole', 'Nicole', 'Female', 'American English', 'en-us', 'soft, close'),
  v('af_sarah', 'Sarah', 'Female', 'American English', 'en-us'),
  v('af_nova', 'Nova', 'Female', 'American English', 'en-us', 'bright'),
  v('af_sky', 'Sky', 'Female', 'American English', 'en-us', 'light'),
  v('af_kore', 'Kore', 'Female', 'American English', 'en-us'),
  v('af_aoede', 'Aoede', 'Female', 'American English', 'en-us'),
  v('af_alloy', 'Alloy', 'Female', 'American English', 'en-us'),
  v('af_jessica', 'Jessica', 'Female', 'American English', 'en-us'),
  v('af_river', 'River', 'Female', 'American English', 'en-us'),
  v('bm_george', 'George', 'Male', 'British English', 'en-gb', 'documentary'),
  v('bm_lewis', 'Lewis', 'Male', 'British English', 'en-gb', 'deep'),
  v('bm_daniel', 'Daniel', 'Male', 'British English', 'en-gb', 'calm'),
  v('bm_fable', 'Fable', 'Male', 'British English', 'en-gb', 'storyteller'),
  v('bf_emma', 'Emma', 'Female', 'British English', 'en-gb', 'clear'),
  v('bf_isabella', 'Isabella', 'Female', 'British English', 'en-gb'),
  v('bf_alice', 'Alice', 'Female', 'British English', 'en-gb'),
  v('bf_lily', 'Lily', 'Female', 'British English', 'en-gb'),
  v('hm_omega', 'Omega', 'Male', 'Hindi', 'hi'),
  v('hm_psi', 'Psi', 'Male', 'Hindi', 'hi'),
  v('hf_alpha', 'Alpha', 'Female', 'Hindi', 'hi'),
  v('hf_beta', 'Beta', 'Female', 'Hindi', 'hi'),
  v('em_alex', 'Alex', 'Male', 'Spanish', 'es'),
  v('ef_dora', 'Dora', 'Female', 'Spanish', 'es'),
  v('ff_siwis', 'Siwis', 'Female', 'French', 'fr-fr'),
  v('im_nicola', 'Nicola', 'Male', 'Italian', 'it'),
  v('if_sara', 'Sara', 'Female', 'Italian', 'it'),
  v('pm_alex', 'Alex', 'Male', 'Portuguese (BR)', 'pt-br'),
  v('pf_dora', 'Dora', 'Female', 'Portuguese (BR)', 'pt-br'),
  v('jm_kumo', 'Kumo', 'Male', 'Japanese', 'ja'),
  v('jf_alpha', 'Alpha', 'Female', 'Japanese', 'ja'),
  v('zm_yunxi', 'Yunxi', 'Male', 'Mandarin', 'cmn'),
  v('zf_xiaoxiao', 'Xiaoxiao', 'Female', 'Mandarin', 'cmn'),
];
export const VOICE_IDS = new Set(VOICES.map((x) => x.id));
export const voiceById = (id: string) => VOICES.find((x) => x.id === id);

const SAMPLE: Record<string, string> = {
  'en-us': 'In the year twelve ninety-eight, a forgotten king changed the course of history. Here is his story.',
  'en-gb': 'In the year twelve ninety-eight, a forgotten king changed the course of history. Here is his story.',
  hi: 'बारह सौ अट्ठानवे में, एक भूले हुए राजा ने इतिहास की दिशा बदल दी। यह उसकी कहानी है।',
  es: 'En el año mil doscientos noventa y ocho, un rey olvidado cambió el curso de la historia.',
  'fr-fr': 'En mille deux cent quatre-vingt-dix-huit, un roi oublié a changé le cours de l’histoire.',
  it: 'Nel milleduecentonovantotto, un re dimenticato cambiò il corso della storia.',
  'pt-br': 'Em mil duzentos e noventa e oito, um rei esquecido mudou o curso da história.',
  ja: '千二百九十八年、忘れられた王が歴史を変えました。',
  cmn: '一二九八年，一位被遗忘的国王改变了历史。',
};

/** Speaks a short sample with the given voice; cached per voice and speed. */
export async function voicePreview(id: string, speed: number): Promise<string> {
  const voice = voiceById(id);
  if (!voice) throw new Error(`Unknown voice "${id}"`);
  const sp = speed >= 0.7 && speed <= 1.3 ? Math.round(speed * 100) / 100 : 0.92;
  const dir = path.join(DATA_DIR, 'voice-previews', `${id}-${sp}`);
  const wav = path.join(dir, 'sample.wav');
  if (fs.existsSync(wav)) return wav;
  const python = path.join(LIB_DIR, '.venv', 'bin', 'python');
  const script = path.join(LIB_DIR, 'core', 'tts', 'tts.py');
  if (!fs.existsSync(python) || !fs.existsSync(script)) throw new Error('Voice tools are not installed yet. Install video tools in Settings first.');
  fs.mkdirSync(dir, { recursive: true });
  const lines = path.join(dir, 'lines.json');
  fs.writeFileSync(lines, JSON.stringify([{ id: 'sample', text: SAMPLE[voice.lang] ?? SAMPLE['en-us'], voice: id, speed: sp, lang: voice.lang }]));
  await new Promise<void>((resolve, reject) => {
    execFile(python, [script, lines, dir], { cwd: LIB_DIR, timeout: 120_000 }, (err, _out, stderr) =>
      err ? reject(new Error(`Voice preview failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`)) : resolve());
  });
  if (!fs.existsSync(wav)) throw new Error('Voice preview failed: no audio was written');
  return wav;
}

/** The narration brief handed to the produce step. */
export function voiceBrief(p: { voice: boolean; voice_name: string; voice_speed: number; voice_style: string }): string {
  if (!p.voice) return 'none — no narration';
  const parts: string[] = [];
  const v = p.voice_name ? voiceById(p.voice_name) : undefined;
  parts.push(v
    ? `yes. Narrator: Kokoro voice \`${v.id}\` (${v.name}, ${v.gender.toLowerCase()}, ${v.accent}) with "lang": "${v.lang}" — use exactly this voice for every line, do not cast another`
    : 'yes. Narrator: cast the voice that best fits this film');
  if (p.voice_speed) parts.push(`speaking speed ${p.voice_speed} (the "speed" value in lines.json)`);
  if (p.voice_style.trim()) parts.push(`delivery: ${p.voice_style.trim()}`);
  return parts.join('; ');
}
