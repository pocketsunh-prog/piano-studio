/**
 * Optional DeepSeek-backed generation.
 *
 * The key is supplied by the user in the browser (stored only if they choose
 * "remember"), and sent directly to the DeepSeek API — the app has no backend.
 * DeepSeek returns a strict JSON piano score that is validated and converted to
 * the same `Score` model used everywhere else.
 */
import type { NoteEvent, Score } from '../types';
import { createScore } from '../score';
import { keySignatureName } from '../pitch';
import {
  AI_MOODS,
  AI_STYLES,
  aiKeyName,
  aiKeySignature,
  type AiComposition,
  type AiDifficulty,
  type AiMood,
  type AiStyle,
  type AiTimeSignature,
} from './composer';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

export const DEEPSEEK_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'deepseek-flash', label: 'DeepSeek Flash — fast' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro — highest quality' },
];

export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';

export interface DeepSeekConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export interface DeepSeekComposeRequest {
  prompt: string;
  style: AiStyle;
  mood: AiMood;
  keyRoot: number;
  mode: 'major' | 'minor';
  bars: number;
  bpm?: number;
  timeSignature: AiTimeSignature;
  difficulty: AiDifficulty;
}

export class DeepSeekError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
  }
}

interface DeepSeekChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
  error?: { message?: string; type?: string };
}

interface DeepSeekScoreJson {
  title?: unknown;
  composer?: unknown;
  key?: unknown;
  tempo?: unknown;
  timeSignature?: unknown;
  bars?: unknown;
  notes?: unknown;
}

const NOTE_BASE: Record<string, number> = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function beatsPerBar(timeSignature: AiTimeSignature): number {
  return timeSignature === '3/4' ? 3 : timeSignature === '6/8' ? 3 : 4;
}

function clampBars(bars: number): number {
  const rounded = Math.round(bars / 4) * 4;
  return clamp(rounded, 8, 16);
}

function tempoFor(request: DeepSeekComposeRequest): number {
  if (request.bpm && Number.isFinite(request.bpm)) return clamp(Math.round(request.bpm), 45, 180);
  const styleTempo: Record<AiStyle, number> = {
    classical: 96,
    romantic: 74,
    pop: 104,
    ambient: 64,
    jazz: 112,
    waltz: 108,
  };
  const moodTempo: Record<AiMood, number> = {
    happy: 8,
    calm: -8,
    melancholic: -6,
    epic: 4,
    dreamy: -10,
  };
  return clamp(styleTempo[request.style] + moodTempo[request.mood], 45, 180);
}

function buildSystemPrompt(): string {
  return [
    'You are Piano Studio, an expert piano composer. Return exactly one JSON object and nothing else.',
    'This is a JSON-only task: never wrap the JSON in markdown and never add commentary.',
    'JSON schema:',
    '{',
    '  "title": "short evocative title (max 60 chars)",',
    '  "composer": "DeepSeek AI",',
    '  "key": { "fifths": -7..7, "mode": "major" | "minor" },',
    '  "tempo": 45..180,',
    '  "timeSignature": { "numerator": 3|4|6, "denominator": 4|8 },',
    '  "bars": integer,',
    '  "notes": [',
    '    { "midi": 21..108, "start": beat, "duration": beats, "velocity": 1..127, "hand": "left" | "right" }',
    '  ]',
    '}',
    'Composition rules:',
    '- Write a musical two-hand piano piece with a clear melody in the right hand and accompaniment in the left hand.',
    '- Use exactly the requested number of bars; notes start at 0 and stay inside the piece. Beats are quarter-note beats.',
    '- Left hand MIDI 36..60, right hand MIDI 60..96. Chords may share a start time. Avoid unplayable leaps.',
    '- Follow the requested key, tempo, meter and difficulty. Use the chord progression implied by the keys and style.',
    '- Return between 60 and 320 notes, both hands present.',
    '- Note starts and durations should be multiples of 0.25 or 0.5 beats where possible.',
  ].join('\n');
}

function buildUserPrompt(request: DeepSeekComposeRequest, bars: number, beats: number): string {
  const styleLabel = AI_STYLES.find((entry) => entry.value === request.style)?.label ?? request.style;
  const moodLabel = AI_MOODS.find((entry) => entry.value === request.mood)?.label ?? request.mood;
  const keyName = aiKeyName(request.keyRoot, request.mode);
  const prompt = request.prompt.trim() || `${moodLabel} ${styleLabel.toLowerCase()} piano piece`;
  const density =
    request.difficulty === 'easy'
      ? 'simple rhythms, mostly quarter/eighth notes, sparse chords'
      : request.difficulty === 'advanced'
        ? 'rich texture with arpeggios, 7th chords and faster eighth/sixteenth figures'
        : 'moderate texture with chord tones and occasional passing notes';
  return [
    `Compose a piano piece for this request: "${prompt}".`,
    `Style: ${styleLabel}. Mood: ${moodLabel}. Key: ${keyName}.`,
    `Length: ${bars} bars of ${request.timeSignature} (${bars * beats} beats total).`,
    `Tempo: about ${tempoFor(request)} BPM. Difficulty: ${request.difficulty} — ${density}.`,
    `Set key.fifths correctly for ${keyName} and timeSignature accordingly.`,
    'Return the JSON object only.',
  ].join('\n');
}

function extractJson(content: string): DeepSeekScoreJson {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new DeepSeekError('DeepSeek did not return a JSON score. Try the local composer or retry.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new DeepSeekError('DeepSeek returned malformed JSON. Please retry.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeepSeekError('DeepSeek returned an unexpected score format. Please retry.');
  }
  return parsed as DeepSeekScoreJson;
}

function parseKey(
  value: unknown,
  request: DeepSeekComposeRequest,
): { fifths: number; mode: 'major' | 'minor'; name: string } {
  if (value && typeof value === 'object') {
    const candidate = value as { fifths?: unknown; mode?: unknown };
    const fifths = Number(candidate.fifths);
    const mode = candidate.mode === 'minor' ? 'minor' : candidate.mode === 'major' ? 'major' : null;
    if (Number.isInteger(fifths) && fifths >= -7 && fifths <= 7 && mode) {
      return { fifths, mode, name: keySignatureName(fifths, mode) };
    }
  }
  if (typeof value === 'string') {
    const match = /\b([a-g])([#b]?)\s*(major|minor)\b/i.exec(value);
    if (match) {
      let pc = NOTE_BASE[match[1].toLowerCase()];
      if (match[2] === '#') pc += 1;
      if (match[2] === 'b') pc -= 1;
      const mode = match[3].toLowerCase() === 'minor' ? 'minor' : 'major';
      const signature = aiKeySignature(((pc % 12) + 12) % 12, mode);
      return { ...signature, name: aiKeyName(((pc % 12) + 12) % 12, mode) };
    }
  }
  const fallback = aiKeySignature(request.keyRoot, request.mode);
  return { ...fallback, name: aiKeyName(request.keyRoot, request.mode) };
}

function parseTimeSignature(
  value: unknown,
  request: DeepSeekComposeRequest,
): { signature: AiTimeSignature; numerator: number; denominator: number } {
  if (value && typeof value === 'object') {
    const candidate = value as { numerator?: unknown; denominator?: unknown };
    const numerator = Number(candidate.numerator);
    const denominator = Number(candidate.denominator);
    const signature =
      numerator === 3 && denominator === 4
        ? ('3/4' as const)
        : numerator === 6 && denominator === 8
          ? ('6/8' as const)
          : numerator === 4 && denominator === 4
            ? ('4/4' as const)
            : null;
    if (signature) return { signature, numerator, denominator };
  }
  const signature = request.timeSignature;
  return {
    signature,
    numerator: signature === '3/4' ? 3 : signature === '6/8' ? 6 : 4,
    denominator: signature === '6/8' ? 8 : 4,
  };
}

function parseNotes(value: unknown): NoteEvent[] {
  if (!Array.isArray(value)) return [];
  const notes: NoteEvent[] = [];
  const seen = new Set<string>();
  const maxNotes = 1200;
  for (let index = 0; index < value.length && notes.length < maxNotes; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as {
      midi?: unknown;
      start?: unknown;
      duration?: unknown;
      velocity?: unknown;
      hand?: unknown;
    };
    const midi = Number(candidate.midi);
    const start = Number(candidate.start);
    const duration = Number(candidate.duration);
    if (!Number.isFinite(midi) || !Number.isFinite(start) || !Number.isFinite(duration)) continue;
    if (midi < 21 || midi > 108 || start < 0 || duration <= 0) continue;
    const hand =
      candidate.hand === 'left' || candidate.hand === 'right'
        ? candidate.hand
        : midi < 60
          ? 'left'
          : 'right';
    const key = `${Math.round(midi)}:${start}:${hand}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const velocity = Number(candidate.velocity);
    notes.push({
      id: `deepseek-${index}`,
      midi: Math.round(midi),
      start: Math.round(start * 8) / 8,
      duration: Math.min(16, Math.max(0.125, duration)),
      velocity: Number.isFinite(velocity) ? clamp(Math.round(velocity), 1, 127) : 82,
      hand,
      track: hand === 'left' ? 1 : 0,
    });
  }
  return notes;
}

function deepSeekErrorMessage(status: number, payload: DeepSeekChatResponse | null): string {
  const apiMessage = payload?.error?.message?.trim();
  if (status === 401) {
    return 'DeepSeek rejected the API key (401). Check the key on platform.deepseek.com.';
  }
  if (status === 402) {
    return 'The DeepSeek account has insufficient balance (402). Top up or use the local composer.';
  }
  if (status === 429) {
    return 'DeepSeek rate limit reached (429). Wait a moment and retry.';
  }
  if (status === 400 && apiMessage) {
    return `DeepSeek rejected the request: ${apiMessage}`;
  }
  if (status >= 500) {
    return `DeepSeek is temporarily unavailable (${status}). Try again or use the local composer.`;
  }
  return apiMessage
    ? `DeepSeek error ${status}: ${apiMessage}`
    : `DeepSeek request failed (${status}).`;
}

function endpointFor(baseUrl: string | undefined): string {
  const base = (baseUrl?.trim() || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

/**
 * Generates a piano score via the DeepSeek chat completions API.
 * The returned composition has `meta.provider = 'deepseek'`.
 */
export async function composeWithDeepSeek(
  request: DeepSeekComposeRequest,
  config: DeepSeekConfig,
  externalSignal?: AbortSignal,
): Promise<AiComposition> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    throw new DeepSeekError('Enter your DeepSeek API key first.');
  }
  const model = config.model?.trim() || DEEPSEEK_DEFAULT_MODEL;
  const bars = clampBars(request.bars);
  const beats = beatsPerBar(request.timeSignature);
  const endpoint = endpointFor(config.baseUrl);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 120_000);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(request, bars, beats) },
        ],
        temperature: 0.78,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (externalSignal?.aborted) throw new DeepSeekError('DeepSeek generation was cancelled.');
    if (controller.signal.aborted) {
      throw new DeepSeekError('DeepSeek took too long to respond. Try again with fewer bars.');
    }
    throw new DeepSeekError(
      `Could not reach DeepSeek at ${endpoint}. Check your connection and base URL.`,
    );
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }

  let payload: DeepSeekChatResponse | null = null;
  let responseText = '';
  try {
    responseText = await response.text();
    payload = responseText ? (JSON.parse(responseText) as DeepSeekChatResponse) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new DeepSeekError(deepSeekErrorMessage(response.status, payload), response.status);
  }

  const choice = payload?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new DeepSeekError(
      'DeepSeek’s score was cut off (token limit). Try 8 bars or a simpler prompt.',
    );
  }
  const content = choice?.message?.content?.trim();
  if (!content) {
    throw new DeepSeekError(
      'DeepSeek returned an empty score. This can happen occasionally — retry or use 8 bars.',
    );
  }

  const parsed = extractJson(content);
  const notes = parseNotes(parsed.notes);
  const left = notes.filter((note) => note.hand === 'left').length;
  const right = notes.filter((note) => note.hand === 'right').length;
  if (notes.length < 8 || left < 2 || right < 2) {
    throw new DeepSeekError(
      'DeepSeek’s JSON did not contain a usable two-hand piano score. Try again or use the local composer.',
    );
  }

  const meter = parseTimeSignature(parsed.timeSignature, request);
  const key = parseKey(parsed.key, request);
  const tempoCandidate = Number(parsed.tempo);
  const bpm = Number.isFinite(tempoCandidate)
    ? clamp(Math.round(tempoCandidate), 45, 180)
    : tempoFor(request);
  const barBeats = beatsPerBar(meter.signature);
  const maxEnd = notes.reduce((end, note) => Math.max(end, note.start + note.duration), 0);
  const modelBars = Number(parsed.bars);
  const barsFromNotes = Math.ceil(maxEnd / barBeats - 1e-6);
  const finalBars = clamp(
    Number.isFinite(modelBars) && modelBars >= 1 ? Math.round(modelBars) : barsFromNotes,
    Math.max(4, barsFromNotes),
    32,
  );
  const totalBeats = finalBars * barBeats;
  const clippedNotes = notes
    .filter((note) => note.start < totalBeats - 1e-9)
    .map((note) => ({
      ...note,
      duration: Math.min(note.duration, totalBeats - note.start),
    }))
    .filter((note) => note.duration >= 0.125);

  const rawTitle = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const title = (rawTitle || `DeepSeek Sketch in ${key.name}`).slice(0, 80);
  const composer =
    typeof parsed.composer === 'string' && parsed.composer.trim()
      ? parsed.composer.trim().slice(0, 80)
      : 'DeepSeek AI';
  const styleLabel = AI_STYLES.find((entry) => entry.value === request.style)?.label ?? request.style;
  const moodLabel = AI_MOODS.find((entry) => entry.value === request.mood)?.label ?? request.mood;
  const promptSummary = request.prompt.trim().slice(0, 140);
  const description = `${moodLabel} ${styleLabel.toLowerCase()} in ${key.name}, ${finalBars} bars at ${bpm} BPM. Generated with DeepSeek (${model})${
    promptSummary ? ` from “${promptSummary}”` : ''
  }.`;

  const score: Score = createScore({
    title,
    composer,
    notes: clippedNotes,
    tempo: [{ beat: 0, bpm }],
    timeSignatures: [
      { beat: 0, numerator: meter.numerator, denominator: meter.denominator },
    ],
    keySignature: { fifths: key.fifths, mode: key.mode },
    source: 'builtin',
    lengthBeats: totalBeats,
  });

  return {
    score,
    meta: {
      title,
      description,
      style: request.style,
      mood: request.mood,
      keyName: key.name,
      bars: finalBars,
      bpm,
      timeSignature: meter.signature,
      difficulty: request.difficulty,
      seed: 0,
      provider: 'deepseek',
      model,
    },
  };
}
