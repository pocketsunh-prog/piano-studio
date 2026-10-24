/**
 * Grid quantization for imported/recorded scores.
 *
 * The grid is expressed in quarter-note beats: pass `0.25` for sixteenth
 * notes, `0.5` for eighths, `1` for quarters. Note starts and durations are
 * snapped to the nearest grid multiple; durations never collapse to zero
 * (they become one grid step). Best effort for triplets, as documented in the
 * integration contract.
 */
import { normalizeScore, notesEndBeat } from '../score';
import type { NoteEvent, Score } from '../types';

export const DEFAULT_QUANTIZE_GRID = 0.25;

function validateGrid(grid: number): number {
  if (!Number.isFinite(grid) || grid <= 0) {
    throw new Error('Quantize grid must be a positive number of beats (e.g. 0.25 for sixteenths).');
  }
  return grid;
}

function cleanBeat(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/**
 * Returns a copy of `notes` with starts/durations snapped to `grid` (in beats).
 * The result is sorted by start, then pitch.
 */
export function quantizeNotes(notes: NoteEvent[], grid = DEFAULT_QUANTIZE_GRID): NoteEvent[] {
  const step = validateGrid(grid);
  const snap = (value: number): number => Math.round(value / step) * step;
  return notes
    .map((note) => {
      const rawStart = Math.max(0, snap(Number.isFinite(note.start) ? note.start : 0));
      const rawDuration = snap(Number.isFinite(note.duration) ? note.duration : step);
      if (!Number.isFinite(rawStart) || !Number.isFinite(rawDuration)) {
        throw new Error('Quantize grid is too small for the notes in this score.');
      }
      const start = cleanBeat(rawStart);
      const duration = cleanBeat(Math.max(step, rawDuration));
      return { ...note, start, duration };
    })
    .sort((a, b) => a.start - b.start || a.midi - b.midi);
}

/**
 * Quantizes every note in `score` and recomputes `lengthBeats`. The input score
 * is never mutated.
 */
export function quantizeScore(score: Score, grid = DEFAULT_QUANTIZE_GRID): Score {
  const step = validateGrid(grid);
  const notes = quantizeNotes(score.notes, step);
  return normalizeScore({
    ...score,
    notes,
    lengthBeats: notesEndBeat(notes),
  });
}
