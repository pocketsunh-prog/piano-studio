import type { Hand, NoteEvent, Score, TempoEvent, TimeSignatureEvent } from './types';
import { DEFAULT_TIME_SIGNATURE, DEFAULT_TEMPO } from './types';

/** Sorted copy of tempo events, guaranteeing an event at beat 0. */
export function sortedTempos(score: Score): TempoEvent[] {
  const list = [...score.tempo].sort((a, b) => a.beat - b.beat);
  if (!list.length || list[0].beat > 0) list.unshift({ beat: 0, bpm: DEFAULT_TEMPO });
  else list[0] = { ...list[0], beat: 0 };
  return list;
}

export function sortedTimeSignatures(score: Score): TimeSignatureEvent[] {
  const list = [...score.timeSignatures].sort((a, b) => a.beat - b.beat);
  if (!list.length || list[0].beat > 0) list.unshift({ ...DEFAULT_TIME_SIGNATURE });
  else list[0] = { ...list[0], beat: 0 };
  return list;
}

/** BPM in effect at a musical position. */
export function tempoAt(score: Score, beat: number): number {
  let bpm = DEFAULT_TEMPO;
  for (const ev of sortedTempos(score)) {
    if (ev.beat <= beat + 1e-9) bpm = ev.bpm;
    else break;
  }
  return bpm;
}

export function timeSignatureAt(score: Score, beat: number): TimeSignatureEvent {
  let ts = DEFAULT_TIME_SIGNATURE;
  for (const ev of sortedTimeSignatures(score)) {
    if (ev.beat <= beat + 1e-9) ts = ev;
    else break;
  }
  return ts;
}

/** Converts a musical beat position to seconds from the start. */
export function beatToSeconds(score: Score, beat: number): number {
  const events = sortedTempos(score);
  let seconds = 0;
  let cursor = 0;
  let bpm = events[0].bpm;

  for (const ev of events) {
    if (ev.beat <= cursor + 1e-9) {
      bpm = ev.bpm;
      continue;
    }
    if (ev.beat >= beat) break;
    seconds += ((ev.beat - cursor) * 60) / bpm;
    cursor = ev.beat;
    bpm = ev.bpm;
  }
  seconds += ((beat - cursor) * 60) / bpm;
  return Math.max(0, seconds);
}

/** Converts seconds from the start to a musical beat position. */
export function secondsToBeat(score: Score, seconds: number): number {
  const events = sortedTempos(score);
  let elapsed = 0;
  let cursor = 0;
  let bpm = events[0].bpm;

  for (const ev of events) {
    if (ev.beat <= cursor + 1e-9) {
      bpm = ev.bpm;
      continue;
    }
    const segment = ((ev.beat - cursor) * 60) / bpm;
    if (elapsed + segment >= seconds) {
      return cursor + ((seconds - elapsed) * bpm) / 60;
    }
    elapsed += segment;
    cursor = ev.beat;
    bpm = ev.bpm;
  }
  return cursor + ((seconds - elapsed) * bpm) / 60;
}

export function scoreDurationSeconds(score: Score): number {
  return beatToSeconds(score, Math.max(score.lengthBeats, 0));
}

/** Length of one bar in beats for a time signature. */
export function measureBeats(ts: Pick<TimeSignatureEvent, 'numerator' | 'denominator'>): number {
  return (ts.numerator * 4) / ts.denominator;
}

export interface MeasureInfo {
  index: number;
  /** First beat of the measure. */
  start: number;
  /** First beat after the measure. */
  end: number;
  timeSignature: TimeSignatureEvent;
}

/**
 * Splits a score into measures, honouring time-signature changes. Handles
 * time-signature changes that do not land on a bar line by starting a new
 * measure there.
 */
export function buildMeasures(score: Score, maxMeasures = 2000): MeasureInfo[] {
  const signatures = sortedTimeSignatures(score);
  const endBeat = Math.max(score.lengthBeats, measureBeats(signatures[0]));
  const measures: MeasureInfo[] = [];
  let beat = 0;
  let index = 0;

  while (beat < endBeat - 1e-9 && measures.length < maxMeasures) {
    const ts = timeSignatureAt(score, beat);
    const nextSig = signatures.find((sig) => sig.beat > beat + 1e-9);
    let end = beat + measureBeats(ts);
    if (nextSig && nextSig.beat < end) end = nextSig.beat;
    measures.push({ index, start: beat, end, timeSignature: ts });
    beat = end;
    index += 1;
  }
  return measures;
}

/** Clamps a MIDI note into the 88-key piano range (A0..C8). */
export function clampMidi(midi: number): number {
  return Math.min(108, Math.max(21, Math.round(midi)));
}

export function makeNoteId(seed: number | string): string {
  return `n-${seed}-${Math.random().toString(36).slice(2, 7)}`;
}
