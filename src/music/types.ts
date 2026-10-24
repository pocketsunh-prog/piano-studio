/**
 * Shared score model for Piano Studio.
 *
 * All musical positions are measured in BEATS (quarter notes), independent of
 * tempo. Seconds are derived through `src/music/timing.ts`.
 */

export type Hand = 'left' | 'right';

export interface NoteEvent {
  /** Stable unique id, e.g. "n-12". */
  id: string;
  /** MIDI note number 0..127 (middle C = 60). */
  midi: number;
  /** Onset in beats from the start of the score. */
  start: number;
  /** Length in beats, always > 0. */
  duration: number;
  /** 1..127. */
  velocity: number;
  /** Which hand/staff the note belongs to. */
  hand: Hand;
  /** Source track or MIDI channel, when known (otherwise 0). */
  track?: number;
  /** Optional polyphonic voice index (1 or 2) for notation rendering. */
  voice?: number;
}

export interface TempoEvent {
  /** Beat at which this tempo takes effect. The first event must be at beat 0. */
  beat: number;
  /** Quarter notes per minute. */
  bpm: number;
}

export interface TimeSignatureEvent {
  /** Beat at which this time signature takes effect. */
  beat: number;
  numerator: number;
  /** Note value that gets one beat, e.g. 4 for quarter note. */
  denominator: number;
}

export interface KeySignature {
  /** -7..7, number of sharps (positive) or flats (negative). */
  fifths: number;
  mode: 'major' | 'minor';
}

export type ScoreSource = 'builtin' | 'midi' | 'musicxml' | 'recording';

export interface Score {
  id: string;
  title: string;
  composer: string;
  notes: NoteEvent[];
  /** Sorted by beat; always contains an event at beat 0. */
  tempo: TempoEvent[];
  /** Sorted by beat; always contains an event at beat 0. */
  timeSignatures: TimeSignatureEvent[];
  keySignature: KeySignature;
  /** Ticks per quarter note from the source file (defaults to 480). */
  ppq: number;
  source: ScoreSource;
  /** Total musical length in beats (>= last note end). */
  lengthBeats: number;
}

/** A note resolved to audio-clock seconds for playback. */
export interface TimedNote extends NoteEvent {
  startSec: number;
  durationSec: number;
}

export const DEFAULT_TEMPO = 120;
export const DEFAULT_TIME_SIGNATURE: TimeSignatureEvent = {
  beat: 0,
  numerator: 4,
  denominator: 4,
};
export const DEFAULT_KEY_SIGNATURE: KeySignature = { fifths: 0, mode: 'major' };
export const DEFAULT_PPQ = 480;
