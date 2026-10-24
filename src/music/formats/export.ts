/**
 * Score export helpers: MusicXML, Standard MIDI File and the app's own JSON
 * interchange format.
 */
import { createScore, normalizeScore } from '../score';
import type {
  Hand,
  KeySignature,
  NoteEvent,
  Score,
  ScoreSource,
  TempoEvent,
  TimeSignatureEvent,
} from '../types';
import { writeMidi } from './midi';
import { writeMusicXml } from './musicxml';

export type ExportFormat = 'musicxml' | 'midi' | 'json';

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_JSON_NOTES = 100_000;

const MIME_TYPES: Record<ExportFormat, string> = {
  musicxml: 'application/vnd.recordare.musicxml+xml',
  midi: 'audio/midi',
  json: 'application/json',
};

const EXTENSIONS: Record<ExportFormat, string> = {
  musicxml: 'musicxml',
  midi: 'mid',
  json: 'json',
};

const SCORE_SOURCES: readonly ScoreSource[] = ['builtin', 'midi', 'musicxml', 'recording'];

function sanitizeFileName(title: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned.slice(0, 80).trim() || 'score';
}

/**
 * Builds a downloadable export for `score`. MusicXML and JSON are returned as
 * text; MIDI as bytes.
 */
export function buildExport(
  score: Score,
  format: ExportFormat,
): { fileName: string; mime: string; data: string | Uint8Array } {
  if (format !== 'musicxml' && format !== 'midi' && format !== 'json') {
    throw new Error(`Unsupported export format "${String(format)}".`);
  }
  const fileName = `${sanitizeFileName(score.title)}.${EXTENSIONS[format]}`;
  const mime = MIME_TYPES[format];
  if (format === 'musicxml') return { fileName, mime, data: writeMusicXml(score) };
  if (format === 'midi') return { fileName, mime, data: writeMidi(score) };
  return { fileName, mime, data: scoreToJson(score) };
}

/** Serialises a score to the app's versioned JSON interchange format. */
export function scoreToJson(score: Score): string {
  const normalized = normalizeScore(score);
  const payload = {
    format: 'piano-studio-score',
    version: 1,
    score: {
      id: normalized.id,
      title: normalized.title,
      composer: normalized.composer,
      notes: normalized.notes.map((note) => ({
        id: note.id,
        midi: note.midi,
        start: note.start,
        duration: note.duration,
        velocity: note.velocity,
        hand: note.hand,
        ...(note.track !== undefined ? { track: note.track } : {}),
        ...(note.voice !== undefined ? { voice: note.voice } : {}),
      })),
      tempo: normalized.tempo,
      timeSignatures: normalized.timeSignatures,
      keySignature: normalized.keySignature,
      ppq: normalized.ppq,
      source: normalized.source,
      lengthBeats: normalized.lengthBeats,
    },
  };
  return JSON.stringify(payload);
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(record: JsonRecord, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} has an invalid or missing "${key}" number.`);
  }
  return value;
}

function optionalNumberField(record: JsonRecord, key: string, context: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} has an invalid "${key}" number.`);
  }
  return value;
}

function optionalStringField(record: JsonRecord, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function readNotes(value: unknown): NoteEvent[] {
  if (!Array.isArray(value)) throw new Error('Score JSON is missing its "notes" array.');
  if (value.length > MAX_JSON_NOTES) {
    throw new Error(`Score JSON contains too many notes (limit ${MAX_JSON_NOTES}).`);
  }
  return value.map((entry, index): NoteEvent => {
    const context = `Score JSON note ${index + 1}`;
    if (!isRecord(entry)) throw new Error(`${context} is not an object.`);
    const midi = numberField(entry, 'midi', context);
    const start = numberField(entry, 'start', context);
    const duration = numberField(entry, 'duration', context);
    const velocity = optionalNumberField(entry, 'velocity', context) ?? 80;
    const handValue = entry.hand;
    const hand: Hand =
      handValue === 'left' ? 'left' : handValue === 'right' ? 'right' : midi < 60 ? 'left' : 'right';
    const id = optionalStringField(entry, 'id', `json-${index + 1}`);
    const track = optionalNumberField(entry, 'track', context);
    const voice = optionalNumberField(entry, 'voice', context);
    return {
      id: id || `json-${index + 1}`,
      midi,
      start,
      duration,
      velocity,
      hand,
      track,
      voice: voice === 1 || voice === 2 ? voice : undefined,
    };
  });
}

function readTempo(value: unknown): TempoEvent[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Score JSON "tempo" must be an array.');
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Score JSON tempo event ${index + 1} is not an object.`);
    return {
      beat: numberField(entry, 'beat', `Score JSON tempo event ${index + 1}`),
      bpm: numberField(entry, 'bpm', `Score JSON tempo event ${index + 1}`),
    };
  });
}

function readTimeSignatures(value: unknown): TimeSignatureEvent[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Score JSON "timeSignatures" must be an array.');
  return value.map((entry, index) => {
    const context = `Score JSON time-signature event ${index + 1}`;
    if (!isRecord(entry)) throw new Error(`${context} is not an object.`);
    return {
      beat: numberField(entry, 'beat', context),
      numerator: numberField(entry, 'numerator', context),
      denominator: numberField(entry, 'denominator', context),
    };
  });
}

function readKeySignature(value: unknown): KeySignature {
  if (value === undefined || value === null) return { fifths: 0, mode: 'major' };
  if (!isRecord(value)) throw new Error('Score JSON "keySignature" must be an object.');
  const fifths = numberField(value, 'fifths', 'Score JSON key signature');
  const mode = value.mode === 'minor' ? 'minor' : 'major';
  return { fifths, mode };
}

/**
 * Parses the app's JSON interchange format (also accepts a bare score object).
 * Throws readable errors for malformed/hostile JSON.
 */
export function scoreFromJson(text: string): Score {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('Score JSON is empty.');
  if (text.length > MAX_JSON_BYTES) throw new Error('Score JSON is too large to import.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Score JSON is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new Error('Score JSON must contain an object.');
  const candidate = isRecord(parsed.score) ? parsed.score : parsed;
  const rawNotes = candidate.notes;
  const notes = readNotes(rawNotes);
  const sourceValue = candidate.source;
  const source: ScoreSource = SCORE_SOURCES.includes(sourceValue as ScoreSource)
    ? (sourceValue as ScoreSource)
    : 'recording';
  const ppq = optionalNumberField(candidate, 'ppq', 'Score JSON');
  const lengthBeats = optionalNumberField(candidate, 'lengthBeats', 'Score JSON');
  return createScore({
    id: optionalStringField(candidate, 'id', `score-json-${Date.now().toString(36)}`),
    title: optionalStringField(candidate, 'title', 'Imported score'),
    composer: optionalStringField(candidate, 'composer', ''),
    notes,
    tempo: readTempo(candidate.tempo),
    timeSignatures: readTimeSignatures(candidate.timeSignatures),
    keySignature: readKeySignature(candidate.keySignature),
    ppq: ppq !== undefined ? ppq : undefined,
    source,
    lengthBeats: lengthBeats !== undefined ? lengthBeats : undefined,
  });
}
