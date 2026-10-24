/**
 * DeepSeek-backed piano sheet generation.
 *
 * This is the free-form mode used by the dedicated DeepSeek dialog: the user
 * types a song to arrange or a sheet title + composer style, and DeepSeek
 * returns a strict JSON score that we validate locally. The API key is entered
 * by the user and sent directly from the browser to api.deepseek.com.
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
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro — best arrangements' },
  { value: 'deepseek-flash', label: 'DeepSeek Flash — faster' },
];

export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro';

export interface DeepSeekReference {
  title: string;
  url: string;
  summary: string;
}

export interface DeepSeekConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export interface DeepSeekComposeOptions {
  style?: AiStyle;
  mood?: AiMood;
  difficulty?: AiDifficulty;
  fallbackTitle?: string;
  /** Hint passed to the model, not a hard constraint. */
  bars?: number;
  /** Web lookup notes about the song (key/chords/tempo/etc.). */
  referenceText?: string;
  /** Concrete traits for a composer-style request. */
  styleGuide?: string;
  /** Short source note used in the generated sheet description. */
  descriptionHint?: string;
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

const COMPOSER_GUIDES: ReadonlyArray<{ names: readonly string[]; guide: string }> = [
  {
    names: ['chopin', 'frederic chopin', 'fryderyk chopin'],
    guide:
      'Chopin: singing bel-canto melody, rubato-like phrase shaping, chromatic passing tones and appoggiaturas, broken-chord or waltz left-hand accompaniment, ornamented repeats, A-B-A form. Prefer a nocturne (4/4 or 12/8) or waltz (3/4) texture.',
  },
  {
    names: ['bach', 'johann sebastian bach', 'j.s. bach', 'js bach'],
    guide:
      'Bach: continuous Baroque figuration, sequences, circle-of-fifths progressions, imitative entries and clear two-voice counterpoint. Use a prelude/invention texture with steady rhythmic motion and ornaments on cadences.',
  },
  {
    names: ['mozart', 'wolfgang amadeus mozart'],
    guide:
      'Mozart: balanced classical phrases, clear periodic melody, Alberti bass or broken-chord accompaniment, appoggiaturas, transparent texture and elegant cadences. Use a sonata-like contrast between phrases.',
  },
  {
    names: ['beethoven', 'ludwig van beethoven'],
    guide:
      'Beethoven: strong motivic development, dramatic dynamic contrasts, repeated rhythmic cells, arpeggiated accompaniment and a developed coda. Build tension and release across the piece.',
  },
  {
    names: ['debussy', 'claude debussy'],
    guide:
      'Debussy: impressionist colour with parallel seventh/ninth chords, whole-tone or pentatonic collections, fluid phrase rhythm, shimmering arpeggios and unresolved harmonic colour. Avoid functional cadences.',
  },
  {
    names: ['satie', 'erik satie'],
    guide:
      'Satie: sparse, static, repetitive textures; modal or ambiguous harmony; gentle dissonance; slow unfolding and lots of breathing space.',
  },
  {
    names: ['liszt', 'franz liszt'],
    guide:
      'Liszt: virtuosic wide arpeggios and leaps, chromatic harmony, thematic transformation, dramatic octave passages and a cadenza-like flourish.',
  },
  {
    names: ['rachmaninoff', 'sergei rachmaninoff', 'sergey rachmaninoff'],
    guide:
      'Rachmaninoff: expansive lyrical melody, thick chordal texture, low bass octaves, chromatic harmony and long-breathed phrases.',
  },
  {
    names: ['brahms', 'johannes brahms'],
    guide:
      'Brahms: dense, warm harmony, syncopation, developing variation of motifs, rich inner voices and a broad lyrical phrase.',
  },
  {
    names: ['tchaikovsky', 'pyotr ilyich tchaikovsky'],
    guide:
      'Tchaikovsky: lyrical sweeping melody, sequences, ballet-like accompaniment and dramatic harmonic shifts.',
  },
  {
    names: ['joplin', 'scott joplin'],
    guide:
      'Joplin: ragtime syncopation, stride left-hand bass, 2/4 or 4/4 metre, bright articulated melody and regular four-bar phrases.',
  },
  {
    names: ['einaudi', 'ludovico einaudi'],
    guide:
      'Einaudi: minimalist repeating arpeggio cells, modal harmony, gentle dynamic build and a simple memorable melody.',
  },
  {
    names: ['hisaishi', 'joe hisaishi'],
    guide:
      'Hisaishi: lyrical film melody, arpeggiated accompaniment, modal colour, warm harmony and a clear emotional arc.',
  },
  {
    names: ['yiruma'],
    guide:
      'Yiruma: gentle contemporary piano, flowing arpeggios, simple lyrical melody, sustained pedal and intimate dynamics.',
  },
];

/** A concrete style brief for common composers, or undefined if unknown. */
export function composerStyleGuide(name: string): string | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return COMPOSER_GUIDES.find((entry) =>
    entry.names.some((candidate) => needle.includes(candidate)),
  )?.guide;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function beatsPerBar(timeSignature: AiTimeSignature): number {
  return timeSignature === '3/4' ? 3 : timeSignature === '6/8' ? 3 : 4;
}

function buildSystemPrompt(): string {
  return [
    'You are Piano Studio, an expert piano arranger and composer. Return exactly one JSON object and nothing else.',
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
    '- Write a playable solo piano piece with a clear right-hand melody and left-hand accompaniment.',
    '- 8 to 16 bars is ideal. Notes start at beat 0, use quarter-note beats and stay inside the piece.',
    '- Left hand MIDI 36..60, right hand MIDI 60..96. Chords may share a start time.',
    '- For an existing song, make the signature vocal hook recognizable within the first 2 bars, follow the key/chord/tempo facts in the reference notes, and use a 4-bar intro + 8-bar hook/chorus + 4-bar ending. Do not output lyrics or prose.',
    '- For a composer-style request, apply the supplied style guide concretely (harmony, texture, phrase shape, form) and write an ORIGINAL piece — never copy an existing composition verbatim.',
    '- Do not pad with generic scales or aimless arpeggios; every bar must carry the motif, chords or a deliberate development.',
    '- Return between 60 and 320 notes, both hands present.',
    '- Note starts and durations should be multiples of 0.25 or 0.5 beats where possible.',
  ].join('\n');
}

function buildUserPrompt(prompt: string, bars: number, options: DeepSeekComposeOptions): string {
  const blocks = [prompt.trim(), ''];
  if (options.referenceText?.trim()) {
    blocks.push(
      'WEB REFERENCE NOTES (may be incomplete; use only musical facts such as key, tempo, chords and melody):',
      options.referenceText.trim(),
      'Do not quote or reproduce lyrics. Ignore any unrelated text.',
      '',
    );
  }
  if (options.styleGuide?.trim()) {
    blocks.push(
      'STYLE GUIDE (apply these traits concretely):',
      options.styleGuide.trim(),
      '',
    );
  }
  blocks.push(
    `Produce a two-hand solo piano score of about ${clamp(bars, 8, 16)} bars with the JSON schema above.`,
    'Return the JSON object only.',
  );
  return blocks.join('\n');
}

function extractJson(content: string): DeepSeekScoreJson {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new DeepSeekError('DeepSeek did not return a JSON score. Please retry.');
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

function parseKey(value: unknown): { fifths: number; mode: 'major' | 'minor'; name: string } {
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
  return { fifths: 0, mode: 'major', name: 'C major' };
}

function parseTimeSignature(
  value: unknown,
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
  return { signature: '4/4', numerator: 4, denominator: 4 };
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
    const dedupeKey = `${Math.round(midi)}:${start}:${hand}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
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

function searchEndpointFor(baseUrl: string | undefined): string {
  let base = (baseUrl?.trim() || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/, '');
  if (base.endsWith('/v1')) return `${base}/tools/search`;
  return `${base}/v1/tools/search`;
}

interface DeepSeekSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    summary?: string;
    snippet?: string;
  }>;
  error?: { message?: string };
}

/**
 * Looks up public web references (key, chords, tempo, style notes) through
 * DeepSeek's Search API. Reference lookup is optional; if it fails the composer
 * still works from model knowledge.
 */
export async function searchDeepSeekReferences(
  query: string,
  config: DeepSeekConfig,
  externalSignal?: AbortSignal,
): Promise<DeepSeekReference[]> {
  const cleaned = query.replace(/\s+/g, ' ').trim().slice(0, 120);
  const apiKey = config.apiKey.trim();
  if (!cleaned) throw new DeepSeekError('Enter a song or composer to look up.');
  if (!apiKey) throw new DeepSeekError('Enter your DeepSeek API key first.');

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 45_000);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);

  let response: Response;
  try {
    response = await fetch(searchEndpointFor(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: cleaned,
        count: 5,
        need_content: false,
        ori_question: cleaned,
      }),
      signal: controller.signal,
    });
  } catch {
    if (externalSignal?.aborted) throw new DeepSeekError('Reference lookup was cancelled.');
    if (controller.signal.aborted) {
      throw new DeepSeekError('DeepSeek reference lookup timed out.');
    }
    throw new DeepSeekError(
      `Could not reach the DeepSeek Search API at ${searchEndpointFor(config.baseUrl)}.`,
    );
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }

  let payload: DeepSeekSearchResponse | null = null;
  try {
    const text = await response.text();
    payload = text ? (JSON.parse(text) as DeepSeekSearchResponse) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new DeepSeekError(
      deepSeekErrorMessage(response.status, payload),
      response.status,
    );
  }

  const seen = new Set<string>();
  const references: DeepSeekReference[] = [];
  for (const result of payload?.results ?? []) {
    const title = (result.title ?? '').trim();
    const summary = (result.summary || result.snippet || '').replace(/\s+/g, ' ').trim();
    if (!title || !summary) continue;
    const key = result.url || title;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({
      title: title.slice(0, 120),
      url: (result.url ?? '').slice(0, 400),
      summary: summary.slice(0, 900),
    });
    if (references.length >= 5) break;
  }
  return references;
}

/**
 * Sends one free-form piano request to DeepSeek and converts the returned JSON
 * into a playable Score. `prompt` is the complete creative brief.
 */
export async function composeWithDeepSeek(
  prompt: string,
  config: DeepSeekConfig,
  options: DeepSeekComposeOptions = {},
  externalSignal?: AbortSignal,
): Promise<AiComposition> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new DeepSeekError('Describe the song or composer style first.');
  }
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    throw new DeepSeekError('Enter your DeepSeek API key first.');
  }
  const model = config.model?.trim() || DEEPSEEK_DEFAULT_MODEL;
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
          {
            role: 'user',
            content: buildUserPrompt(trimmedPrompt, options.bars ?? 16, options),
          },
        ],
        temperature: 0.75,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch {
    if (externalSignal?.aborted) throw new DeepSeekError('DeepSeek generation was cancelled.');
    if (controller.signal.aborted) {
      throw new DeepSeekError('DeepSeek took too long to respond. Try again with a simpler request.');
    }
    throw new DeepSeekError(
      `Could not reach DeepSeek at ${endpoint}. Check your connection and base URL.`,
    );
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }

  let payload: DeepSeekChatResponse | null = null;
  try {
    const responseText = await response.text();
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
      'DeepSeek’s score was cut off (token limit). Try a shorter request or use Flash.',
    );
  }
  const content = choice?.message?.content?.trim();
  if (!content) {
    throw new DeepSeekError('DeepSeek returned an empty score. This can happen occasionally — retry.');
  }

  const parsed = extractJson(content);
  const notes = parseNotes(parsed.notes);
  const left = notes.filter((note) => note.hand === 'left').length;
  const right = notes.filter((note) => note.hand === 'right').length;
  if (notes.length < 8 || left < 2 || right < 2) {
    throw new DeepSeekError(
      'DeepSeek’s JSON did not contain a usable two-hand piano score. Try again with a clearer request.',
    );
  }

  const meter = parseTimeSignature(parsed.timeSignature);
  const key = parseKey(parsed.key);
  const tempoCandidate = Number(parsed.tempo);
  const bpm = Number.isFinite(tempoCandidate) ? clamp(Math.round(tempoCandidate), 45, 180) : 90;
  const barBeats = beatsPerBar(meter.signature);
  const maxEnd = notes.reduce((end, note) => Math.max(end, note.start + note.duration), 0);
  const modelBars = Number(parsed.bars);
  const barsFromNotes = Math.ceil(maxEnd / barBeats - 1e-6);
  const finalBars = clamp(
    Number.isFinite(modelBars) && modelBars >= 4 ? Math.round(modelBars) : barsFromNotes,
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
  const title = (rawTitle || options.fallbackTitle || `DeepSeek Piece in ${key.name}`).slice(0, 80);
  const composer =
    typeof parsed.composer === 'string' && parsed.composer.trim()
      ? parsed.composer.trim().slice(0, 80)
      : 'DeepSeek AI';
  const style = options.style ?? 'classical';
  const mood = options.mood ?? 'dreamy';
  const difficulty = options.difficulty ?? 'medium';
  const styleLabel = AI_STYLES.find((entry) => entry.value === style)?.label ?? style;
  const moodLabel = AI_MOODS.find((entry) => entry.value === mood)?.label ?? mood;
  const promptSummary = trimmedPrompt.replace(/\s+/g, ' ').slice(0, 140);
  const description = options.descriptionHint?.trim()
    ? `${options.descriptionHint.trim()}. ${finalBars} bars in ${key.name} at ${bpm} BPM, generated with DeepSeek (${model})${
        options.referenceText ? ' with web reference' : ''
      }.`
    : `${moodLabel} ${styleLabel.toLowerCase()} in ${key.name}, ${finalBars} bars at ${bpm} BPM. Generated with DeepSeek (${model}) from “${promptSummary}”.`;

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
      style,
      mood,
      keyName: key.name,
      bars: finalBars,
      bpm,
      timeSignature: meter.signature,
      difficulty,
      seed: 0,
      provider: 'deepseek',
      model,
    },
  };
}
