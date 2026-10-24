/**
 * Pure notation model for the sheet-music renderer.
 *
 * This module turns the shared `Score` model (quarter-note beats) into a
 * measure-by-measure, two-voice-per-staff display model that the VexFlow
 * renderer can draw. It has no DOM / VexFlow dependency so it can be unit
 * tested directly.
 *
 * Key rules from CONTRACT.md §3:
 * - notes are split between a treble (right hand) and bass (left hand) staff,
 *   falling back to a pitch split at middle C when `hand` is missing/invalid;
 * - at most two voices per staff (chords share a start, overlapping independent
 *   lines go to voice 2);
 * - the input score is never mutated; display copies are quantized to a 1/16
 *   note grid (0.25 quarter-note beats);
 * - measures are filled with rests and notes crossing barlines are split and
 *   tied (tie chains are described by `tieGroup`).
 */
import type { Hand, KeySignature, NoteEvent, Score, TimeSignatureEvent } from '../music/types';
import { buildMeasures, clampMidi, measureBeats, type MeasureInfo } from '../music/timing';
import { midiToKeyName } from '../music/pitch';

/** Display quantization grid: one sixteenth note expressed in quarter-note beats. */
export const DISPLAY_GRID = 0.25;
/** Hard caps so hostile/oversized input cannot exhaust memory. */
export const MAX_TOTAL_MEASURES = 2000;
export const MAX_RENDER_MEASURES = 400;
export const MAX_DISPLAY_NOTES = 20000;

const EPS = 1e-6;

/** Which staff a note is drawn on. */
export type StaffId = 'treble' | 'bass';
/** Notation voices are limited to two per staff. */
export type VoiceNumber = 1 | 2;
/** VexFlow duration codes used by the display model. */
export type VexDurationCode = 'w' | 'h' | 'q' | '8' | '16' | '32' | '64';

export interface DurationValue {
  /** VexFlow duration code, e.g. `q`. */
  duration: VexDurationCode;
  /** Number of augmenting dots. */
  dots: number;
  /** Sounding length in quarter-note beats. */
  beats: number;
}

export interface VexKey {
  /** VexFlow key string, e.g. `bb/4`. */
  key: string;
  /** MIDI note number this key represents. */
  midi: number;
}

/** A note after sanitising/quantising, before chord grouping. */
export interface PreparedNote {
  id: string;
  midi: number;
  /** Quantized onset in beats. */
  start: number;
  /** Quantized duration in beats (> 0). */
  duration: number;
  staff: StaffId;
  hand: Hand;
  voiceHint?: VoiceNumber;
}

/** Notes sharing a start + duration on one staff, assigned to one voice. */
export interface DisplayChord {
  start: number;
  duration: number;
  /** Sorted ascending, de-duplicated MIDI pitches. */
  midis: number[];
  /** Source note ids (used for playback highlighting). */
  noteIds: string[];
  staff: StaffId;
  voice: VoiceNumber;
}

/** One rendered note/rest segment. */
export interface MeasureEvent {
  kind: 'note' | 'rest';
  /** Position inside the measure, in beats. */
  offset: number;
  /** Sounding length in beats. */
  beats: number;
  duration: VexDurationCode;
  dots: number;
  /** Chord keys (notes) or the single rest key (rests). */
  keys: VexKey[];
  /** Source note ids for highlights; empty for rests. */
  noteIds: string[];
  voice: VoiceNumber;
  /** Segments of one tied note share this id. */
  tieGroup?: string;
}

export interface DisplayMeasure {
  /** Measure index in the full score. */
  index: number;
  /** Absolute first beat of the measure. */
  start: number;
  /** Absolute first beat after the measure. */
  end: number;
  /** Length of the measure in beats. */
  beats: number;
  timeSignature: TimeSignatureEvent;
  /** True when this measure starts a new time signature. */
  timeSignatureChanged: boolean;
  events: Record<StaffId, MeasureEvent[]>;
}

/** A single source note with display timing, used for highlighting. */
export interface HighlightNote {
  id: string;
  midi: number;
  start: number;
  end: number;
}

export interface DisplayModel {
  measures: DisplayMeasure[];
  /** Number of measures in the score (capped at MAX_TOTAL_MEASURES). */
  totalMeasures: number;
  /** Number of measures in `measures` (the rendered subset). */
  renderedMeasures: number;
  keySignature: KeySignature;
  /** VexFlow key-signature spec, e.g. `G` or `Am`. */
  keySpec: string;
  /** Sorted by start; used for playback highlighting. */
  highlight: HighlightNote[];
}

export interface MeasureifyOptions {
  /** Display grid in beats. Defaults to 1/16 note (0.25). */
  grid?: number;
  /** Maximum number of measures to model (default 400). */
  maxMeasures?: number;
  /** Pre-computed measures from the caller (must belong to `score`). */
  measures?: readonly MeasureInfo[];
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds a beat position/length onto the display grid. */
export function quantizeBeats(value: number, grid: number = DISPLAY_GRID): number {
  const safeGrid = Number.isFinite(grid) && grid > 0 ? grid : DISPLAY_GRID;
  if (!Number.isFinite(value)) return 0;
  return round6(Math.round(value / safeGrid) * safeGrid);
}

/** Durations VexFlow can express directly, longest first. */
const DURATION_TABLE: readonly DurationValue[] = [
  { duration: 'w', dots: 1, beats: 6 },
  { duration: 'w', dots: 0, beats: 4 },
  { duration: 'h', dots: 1, beats: 3 },
  { duration: 'h', dots: 0, beats: 2 },
  { duration: 'q', dots: 1, beats: 1.5 },
  { duration: 'q', dots: 0, beats: 1 },
  { duration: '8', dots: 1, beats: 0.75 },
  { duration: '8', dots: 0, beats: 0.5 },
  { duration: '16', dots: 1, beats: 0.375 },
  { duration: '16', dots: 0, beats: 0.25 },
  { duration: '32', dots: 0, beats: 0.125 },
  { duration: '64', dots: 0, beats: 0.0625 },
];

/**
 * Maps a beat length to a single VexFlow duration, or `null` when the length
 * needs to be split into tied notes (see `splitBeats`).
 */
export function toVexDuration(beats: number): DurationValue | null {
  const value = round6(beats);
  if (!(value > 0)) return null;
  const match = DURATION_TABLE.find((entry) => Math.abs(entry.beats - value) < EPS);
  return match ? { ...match } : null;
}

/**
 * Splits a beat length into 1..3 exactly representable VexFlow durations
 * (descending). Used for note/rest segments after quantization/clipping.
 */
export function splitBeats(beats: number): DurationValue[] {
  const value = round6(beats);
  if (!(value > 0)) return [];
  const exact = toVexDuration(value);
  if (exact) return [exact];

  const parts: DurationValue[] = [];
  const search = (remaining: number, depth: number): boolean => {
    if (Math.abs(remaining) < EPS) return true;
    if (depth >= 3) return false;
    for (const entry of DURATION_TABLE) {
      if (entry.beats > remaining + EPS) continue;
      parts.push({ ...entry });
      if (search(round6(remaining - entry.beats), depth + 1)) return true;
      parts.pop();
    }
    return false;
  };
  if (search(value, 0)) return parts;

  // Fallback: greedy fill; a sub-1/64 remainder is folded into the last part.
  const greedy: DurationValue[] = [];
  let remaining = value;
  while (remaining > EPS) {
    const entry = DURATION_TABLE.find((candidate) => candidate.beats <= remaining + EPS);
    if (!entry) break;
    greedy.push({ ...entry });
    remaining = round6(remaining - entry.beats);
  }
  if (greedy.length && remaining > EPS) {
    const last = greedy[greedy.length - 1];
    last.beats = round6(last.beats + remaining);
  }
  return greedy;
}

/**
 * Converts a MIDI pitch into a VexFlow key string, spelling it according to the
 * key signature (`fifths`, -7..7). Accidentals themselves are added by
 * `Accidental.applyAccidentals` in the renderer.
 */
export function midiToVexKey(midi: number, fifths = 0): VexKey {
  const safeMidi = clampMidi(Number.isFinite(midi) ? midi : 60);
  const name = midiToKeyName(safeMidi, clamp(Math.round(fifths), -7, 7));
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(name);
  if (!match) return { key: 'c/4', midi: safeMidi };
  const accidental = match[2] === 'b' ? 'b' : match[2] === '#' ? '#' : '';
  return { key: `${match[1].toLowerCase()}${accidental}/${match[3]}`, midi: safeMidi };
}

const MAJOR_KEY_SPECS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'] as const;
const MINOR_KEY_SPECS = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m'] as const;
const MAJOR_FLAT_KEY_SPECS = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'] as const;
const MINOR_FLAT_KEY_SPECS = ['Am', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm'] as const;

/** VexFlow key-signature spec for the shared key signature. */
export function keySignatureSpec(key: KeySignature | undefined): string {
  const fifths = clamp(Math.round(key?.fifths ?? 0), -7, 7);
  const minor = key?.mode === 'minor';
  if (fifths >= 0) {
    return (minor ? MINOR_KEY_SPECS : MAJOR_KEY_SPECS)[fifths] ?? 'C';
  }
  return (minor ? MINOR_FLAT_KEY_SPECS : MAJOR_FLAT_KEY_SPECS)[-fifths] ?? 'C';
}

/** Time-signature string for VexFlow, e.g. `3/8`. */
export function timeSignatureSpec(ts: Pick<TimeSignatureEvent, 'numerator' | 'denominator'>): string {
  const numerator = Math.max(1, Math.round(ts?.numerator || 4));
  const denominator = Math.max(1, Math.round(ts?.denominator || 4));
  return `${numerator}/${denominator}`;
}

/**
 * Resolves the staff for a note. Uses `hand` when present and valid; otherwise
 * (or for malformed input) falls back to the pitch split at middle C.
 */
export function staffForNote(
  note: Pick<NoteEvent, 'midi' | 'hand'>,
  splitMidi = 60,
): StaffId {
  const hand: unknown = (note as { hand?: unknown }).hand;
  const midi = Number.isFinite(note.midi) ? note.midi : splitMidi;
  if (hand === 'left') return 'bass';
  if (hand === 'right') return 'treble';
  return midi < splitMidi ? 'bass' : 'treble';
}

/** Copies + sanitises + quantizes score notes for display (never mutates input). */
export function prepareNotes(score: Score, options: { grid?: number; maxNotes?: number } = {}): PreparedNote[] {
  const grid = Number.isFinite(options.grid) && (options.grid ?? 0) > 0 ? (options.grid as number) : DISPLAY_GRID;
  const maxNotes = options.maxNotes ?? MAX_DISPLAY_NOTES;
  const source = Array.isArray(score?.notes) ? score.notes : [];
  const prepared: PreparedNote[] = [];
  const seen = new Set<string>();

  for (const note of source) {
    if (prepared.length >= maxNotes) break;
    if (!note || typeof note !== 'object') continue;
    if (!Number.isFinite(note.start) || !Number.isFinite(note.duration) || note.duration <= 0) continue;
    if (!Number.isFinite(note.midi)) continue;
    const start = quantizeBeats(Math.max(0, note.start), grid);
    // Snap the length but never collapse a sounding note to nothing.
    const duration = clamp(quantizeBeats(note.duration, grid), grid, 256);
    const midi = clampMidi(note.midi);
    const id = typeof note.id === 'string' && note.id ? note.id : `n-${prepared.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const hand: Hand = note.hand === 'left' ? 'left' : 'right';
    const voiceHint: VoiceNumber | undefined =
      note.voice === 1 ? 1 : note.voice === 2 ? 2 : undefined;
    prepared.push({
      id,
      midi,
      start,
      duration: round6(duration),
      staff: staffForNote(note),
      hand,
      voiceHint,
    });
  }

  prepared.sort((a, b) => a.start - b.start || a.midi - b.midi);
  return prepared;
}

/**
 * Groups prepared notes into chords (same staff, start and duration) and
 * distributes the chords over at most two voices per staff.
 *
 * Voice assignment: chords are visited in time order; a chord goes to voice 1
 * when it does not overlap anything already in voice 1, otherwise to voice 2
 * when free, otherwise (three or more simultaneous lines) to the voice that
 * frees up first ??best effort, never more than two voices.
 */
export function groupIntoVoices(notes: readonly PreparedNote[]): DisplayChord[] {
  const result: DisplayChord[] = [];

  for (const staff of ['treble', 'bass'] as const) {
    type WorkingChord = DisplayChord & { hint?: VoiceNumber };
    const byKey = new Map<string, WorkingChord>();

    for (const note of notes) {
      if (note.staff !== staff) continue;
      const key = `${note.start}|${note.duration}`;
      let chord = byKey.get(key);
      if (!chord) {
        chord = {
          start: note.start,
          duration: note.duration,
          midis: [],
          noteIds: [],
          staff,
          voice: 1,
        };
        byKey.set(key, chord);
      }
      if (!chord.midis.includes(note.midi)) chord.midis.push(note.midi);
      chord.noteIds.push(note.id);
      if (note.voiceHint === 2) chord.hint = 2;
      else if (note.voiceHint === 1 && chord.hint !== 2) chord.hint = 1;
    }

    const chords = [...byKey.values()];
    for (const chord of chords) chord.midis.sort((a, b) => a - b);
    chords.sort(
      (a, b) => a.start - b.start || b.duration - a.duration || (a.midis[0] ?? 0) - (b.midis[0] ?? 0),
    );

    const voiceEnds: [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    const assign = (chord: WorkingChord, voice: VoiceNumber): void => {
      chord.voice = voice;
      voiceEnds[voice - 1] = Math.max(voiceEnds[voice - 1], round6(chord.start + chord.duration));
    };

    const hintedSecond = chords.filter((chord) => chord.hint === 2);
    const hintedFirst = chords.filter((chord) => chord.hint === 1);
    const unhinted = chords.filter((chord) => chord.hint === undefined);

    for (const chord of hintedSecond) assign(chord, 2);
    for (const chord of [...hintedFirst, ...unhinted]) {
      if (chord.start >= voiceEnds[0] - EPS) assign(chord, 1);
      else if (chord.start >= voiceEnds[1] - EPS) assign(chord, 2);
      else assign(chord, voiceEnds[0] <= voiceEnds[1] ? 1 : 2);
    }

    for (const chord of chords) {
      result.push({
        start: chord.start,
        duration: chord.duration,
        midis: chord.midis,
        noteIds: chord.noteIds,
        staff: chord.staff,
        voice: chord.voice,
      });
    }
  }

  result.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.staff !== b.staff) return a.staff === 'treble' ? -1 : 1;
    return a.voice - b.voice;
  });
  return result;
}

/** Rest key for a staff/duration: whole rests hang from the 4th line. */
function restKey(staff: StaffId, duration: VexDurationCode): VexKey {
  const whole = duration === 'w';
  if (staff === 'treble') {
    const key = whole ? 'd/5' : 'b/4';
    return { key, midi: -1 };
  }
  const key = whole ? 'f/3' : 'd/3';
  return { key, midi: -1 };
}

function makeRest(staff: StaffId, voice: VoiceNumber, offset: number, part: DurationValue): MeasureEvent {
  const duration = part.duration;
  return {
    kind: 'rest',
    offset: round6(offset),
    beats: part.beats,
    duration,
    dots: part.dots,
    keys: [restKey(staff, duration)],
    noteIds: [],
    voice,
  };
}

interface MeasureSlots {
  treble: Map<VoiceNumber, MeasureEvent[]>;
  bass: Map<VoiceNumber, MeasureEvent[]>;
}

function emptySlots(): MeasureSlots {
  return { treble: new Map(), bass: new Map() };
}

function eventList(slots: MeasureSlots, staff: StaffId, voice: VoiceNumber): MeasureEvent[] {
  const map = slots[staff];
  let list = map.get(voice);
  if (!list) {
    list = [];
    map.set(voice, list);
  }
  return list;
}

/**
 * Sorts one voice's segments inside a measure, removes overlaps, fills gaps
 * with rests and pads to the end of the measure.
 */
function fillVoice(
  segments: MeasureEvent[],
  measureLength: number,
  staff: StaffId,
  voice: VoiceNumber,
): MeasureEvent[] {
  const sorted = [...segments].sort((a, b) => a.offset - b.offset);
  const out: MeasureEvent[] = [];
  let cursor = 0;

  const pushRests = (offset: number, beats: number): void => {
    if (beats <= EPS) return;
    let position = offset;
    for (const part of splitBeats(beats)) {
      out.push(makeRest(staff, voice, position, part));
      position = round6(position + part.beats);
    }
  };

  for (const segment of sorted) {
    let offset = Math.max(segment.offset, cursor);
    if (offset >= measureLength - EPS) continue;
    let beats = Math.min(segment.beats, round6(measureLength - offset));
    if (beats <= EPS) continue;

    if (offset > cursor + EPS) pushRests(cursor, round6(offset - cursor));

    const clipped = Math.abs(beats - segment.beats) > EPS;
    let parts: DurationValue[];
    if (clipped) {
      parts = splitBeats(beats);
    } else {
      const exact = toVexDuration(beats);
      parts = exact ? [exact] : splitBeats(beats);
    }
    if (parts.length === 0) continue;
    let position = offset;
    for (const part of parts) {
      out.push({
        ...segment,
        offset: round6(position),
        beats: part.beats,
        duration: part.duration,
        dots: part.dots,
      });
      position = round6(position + part.beats);
    }
    cursor = position;
  }

  if (measureLength - cursor > EPS) pushRests(cursor, round6(measureLength - cursor));
  return out;
}

/**
 * Builds the full display model: prepared notes, chords, measure-by-measure
 * note/rest segments, and the highlight timing table.
 */
export function buildDisplayModel(score: Score, options: MeasureifyOptions = {}): DisplayModel {
  const grid = Number.isFinite(options.grid) && (options.grid ?? 0) > 0 ? (options.grid as number) : DISPLAY_GRID;
  const allMeasures: readonly MeasureInfo[] =
    options.measures ?? buildMeasures(score, MAX_TOTAL_MEASURES);
  const maxMeasures = clamp(Math.floor(options.maxMeasures ?? MAX_RENDER_MEASURES), 1, MAX_TOTAL_MEASURES);
  const measures = allMeasures.slice(0, maxMeasures);

  const prepared = prepareNotes(score, { grid });
  const chords = groupIntoVoices(prepared);
  const fifths = clamp(Math.round(score?.keySignature?.fifths ?? 0), -7, 7);
  const keySpec = keySignatureSpec(score?.keySignature);

  const slotsByMeasure = new Map<number, MeasureSlots>();
  for (const measure of measures) slotsByMeasure.set(measure.index, emptySlots());

  const lastBeat = measures.length ? measures[measures.length - 1].end : 0;
  let tieCounter = 0;

  for (const chord of chords) {
    if (chord.start >= lastBeat - EPS) continue;
    // First measure that contains the chord onset.
    let measurePos = -1;
    for (let i = measures.length - 1; i >= 0; i -= 1) {
      if (chord.start >= measures[i].start - EPS) {
        measurePos = i;
        break;
      }
    }
    if (measurePos < 0) measurePos = 0;

    const chordEnd = round6(chord.start + chord.duration);
    const tieGroup = `tie-${tieCounter}`;
    tieCounter += 1;
    const keys = chord.midis.map((midi) => midiToVexKey(midi, fifths));

    for (let i = measurePos; i < measures.length; i += 1) {
      const measure = measures[i];
      if (measure.start >= chordEnd - EPS) break;
      if (measure.end <= chord.start + EPS) continue;

      const overlapStart = Math.max(chord.start, measure.start);
      const overlapEnd = Math.min(chordEnd, measure.end);
      const length = round6(overlapEnd - overlapStart);
      if (length <= EPS) continue;

      const slots = slotsByMeasure.get(measure.index);
      if (!slots) continue;
      const list = eventList(slots, chord.staff, chord.voice);
      const parts = splitBeats(length);
      let offset = round6(overlapStart - measure.start);
      for (const part of parts) {
        list.push({
          kind: 'note',
          offset: round6(offset),
          beats: part.beats,
          duration: part.duration,
          dots: part.dots,
          keys,
          noteIds: chord.noteIds,
          voice: chord.voice,
          tieGroup,
        });
        offset = round6(offset + part.beats);
      }
    }
  }

  const displayMeasures: DisplayMeasure[] = [];
  let previousSignature: TimeSignatureEvent | null = null;

  for (const measure of measures) {
    const slots = slotsByMeasure.get(measure.index) ?? emptySlots();
    const length = round6(Math.max(0.0625, measure.end - measure.start));
    const events: Record<StaffId, MeasureEvent[]> = { treble: [], bass: [] };

    for (const staff of ['treble', 'bass'] as const) {
      let voiceMap = slots[staff];
      if (voiceMap.size === 0) {
        // No notes on this staff: a single voice of rests keeps the staves aligned.
        const rests: MeasureEvent[] = [];
        let position = 0;
        for (const part of splitBeats(length)) {
          rests.push(makeRest(staff, 1, position, part));
          position = round6(position + part.beats);
        }
        events[staff] = rests;
        continue;
      }
      // Only materialise voices that actually have notes in this measure.
      voiceMap = new Map([...voiceMap.entries()].filter(([, list]) => list.length > 0));
      if (voiceMap.size === 0) {
        const rests: MeasureEvent[] = [];
        let position = 0;
        for (const part of splitBeats(length)) {
          rests.push(makeRest(staff, 1, position, part));
          position = round6(position + part.beats);
        }
        events[staff] = rests;
        continue;
      }
      const merged: MeasureEvent[] = [];
      const voices = [...voiceMap.keys()].sort((a, b) => a - b);
      for (const voice of voices) {
        const voiceSegments = fillVoice(voiceMap.get(voice) ?? [], length, staff, voice);
        merged.push(...voiceSegments);
      }
      events[staff] = merged;
    }

    const signature: TimeSignatureEvent = measure.timeSignature ?? {
      beat: 0,
      numerator: 4,
      denominator: 4,
    };
    const changed =
      previousSignature === null ||
      previousSignature.numerator !== signature.numerator ||
      previousSignature.denominator !== signature.denominator;
    previousSignature = signature;

    displayMeasures.push({
      index: measure.index,
      start: measure.start,
      end: measure.end,
      beats: length,
      timeSignature: signature,
      timeSignatureChanged: changed,
      events,
    });
  }

  const highlight: HighlightNote[] = prepared.map((note) => ({
    id: note.id,
    midi: note.midi,
    start: note.start,
    end: round6(note.start + note.duration),
  }));
  highlight.sort((a, b) => a.start - b.start);

  return {
    measures: displayMeasures,
    totalMeasures: allMeasures.length,
    renderedMeasures: displayMeasures.length,
    keySignature: score?.keySignature ?? { fifths: 0, mode: 'major' },
    keySpec,
    highlight,
  };
}

/**
 * Convenience wrapper: measure-by-measure display model only.
 * (Kept as its own export because the CONTRACT names it explicitly.)
 */
export function measureify(score: Score, options: MeasureifyOptions = {}): DisplayMeasure[] {
  return buildDisplayModel(score, options).measures;
}

/** Length of a measure in beats for a time signature. */
export function measureLength(ts: Pick<TimeSignatureEvent, 'numerator' | 'denominator'>): number {
  return round6(measureBeats(ts));
}

/**
 * Source note ids that should be highlighted for a playback position.
 * A note is highlighted when `currentBeat` lies inside its (quantized) sounding
 * window; when `activeMidis` is non-empty the pitch must also be sounding.
 */
export function activeNoteIds(
  notes: readonly HighlightNote[],
  currentBeat: number,
  activeMidis?: readonly number[],
  tolerance = 0.1,
): string[] {
  if (!Number.isFinite(currentBeat) || notes.length === 0) return [];
  const midiFilter =
    Array.isArray(activeMidis) && activeMidis.length > 0
      ? new Set(activeMidis.filter((midi) => Number.isFinite(midi)))
      : null;
  const ids: string[] = [];
  for (const note of notes) {
    if (note.start > currentBeat + tolerance) break;
    if (note.end <= currentBeat) continue;
    if (midiFilter && !midiFilter.has(note.midi)) continue;
    ids.push(note.id);
  }
  return ids;
}

/** Index (into `measures`) of the measure containing a beat. */
export function measureIndexAtBeat(
  measures: readonly { start: number; end: number }[],
  beat: number,
): number {
  if (measures.length === 0) return -1;
  if (!Number.isFinite(beat) || beat <= measures[0].start) return 0;
  for (let i = measures.length - 1; i >= 0; i -= 1) {
    if (beat >= measures[i].start - EPS) return i;
  }
  return measures.length - 1;
}
