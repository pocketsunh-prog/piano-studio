import { describe, expect, it } from 'vitest';
import { createScore } from '../score';
import type { NoteEvent } from '../types';
import { quantizeNotes, quantizeScore } from './quantize';

function note(partial: Partial<NoteEvent> & Pick<NoteEvent, 'midi' | 'start' | 'duration'>): NoteEvent {
  return {
    id: partial.id ?? `n-${partial.midi}-${partial.start}`,
    midi: partial.midi,
    start: partial.start,
    duration: partial.duration,
    velocity: partial.velocity ?? 80,
    hand: partial.hand ?? 'right',
  };
}

describe('quantizeNotes', () => {
  it('snaps starts and durations to the grid and keeps zero-duration notes alive', () => {
    const input = [
      note({ id: 'a', midi: 60, start: 0.13, duration: 0.36 }),
      note({ id: 'b', midi: 62, start: 0.63, duration: 0.05 }),
      note({ id: 'c', midi: 64, start: 1.02, duration: 0.74 }),
      note({ id: 'd', midi: 65, start: 0.02, duration: 0.01 }),
    ];
    const snapshot = JSON.stringify(input);
    const quantized = quantizeNotes(input, 0.25);

    expect(quantized.map((item) => item.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(quantized[0].start).toBe(0);
    expect(quantized[0].duration).toBe(0.25);
    expect(quantized[1].start).toBe(0.25);
    expect(quantized[1].duration).toBe(0.25);
    expect(quantized[2].start).toBe(0.75);
    expect(quantized[2].duration).toBe(0.25);
    expect(quantized[3].start).toBe(1);
    expect(quantized[3].duration).toBe(0.75);

    // Sorted, deterministic output and no mutation of the input.
    for (let i = 1; i < quantized.length; i += 1) {
      expect(quantized[i].start).toBeGreaterThanOrEqual(quantized[i - 1].start);
    }
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('uses a quarter-beat grid by default and accepts coarser grids', () => {
    const defaultGrid = quantizeNotes([note({ midi: 60, start: 0.1, duration: 0.1 })]);
    expect(defaultGrid[0].start).toBe(0);
    expect(defaultGrid[0].duration).toBe(0.25);

    const eighths = quantizeNotes([note({ midi: 60, start: 0.4, duration: 0.3 })], 0.5);
    expect(eighths[0].start).toBe(0.5);
    expect(eighths[0].duration).toBe(0.5);
  });

  it('rejects invalid grids', () => {
    const notes = [note({ midi: 60, start: 0, duration: 1 })];
    expect(() => quantizeNotes(notes, 0)).toThrow(/positive/);
    expect(() => quantizeNotes(notes, -0.25)).toThrow(/positive/);
    expect(() => quantizeNotes(notes, Number.NaN)).toThrow(/positive/);
  });
});

describe('quantizeScore', () => {
  it('quantizes notes, preserves musical context and recomputes lengthBeats', () => {
    const score = createScore({
      title: 'Quantize Me',
      notes: [
        note({ midi: 60, start: 0.4, duration: 0.3, hand: 'right' }),
        note({ midi: 48, start: 1.1, duration: 0.3, hand: 'left' }),
        note({ midi: 67, start: 2.3, duration: 0.4, hand: 'right' }),
      ],
      tempo: [{ beat: 0, bpm: 88 }],
      timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }],
      keySignature: { fifths: 1, mode: 'major' },
      lengthBeats: 16,
    });

    const quantized = quantizeScore(score, 0.5);

    expect(quantized.notes.map((item) => item.start)).toEqual([0.5, 1, 2.5]);
    expect(quantized.notes.every((item) => item.duration === 0.5)).toBe(true);
    expect(quantized.lengthBeats).toBeCloseTo(3, 9);
    expect(quantized.tempo[0].bpm).toBeCloseTo(88, 9);
    expect(quantized.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
    expect(quantized.keySignature).toEqual({ fifths: 1, mode: 'major' });

    // The original score is untouched.
    expect(score.lengthBeats).toBe(16);
    expect(score.notes[0].start).toBeCloseTo(0.4, 9);
  });

  it('handles empty scores and validates its grid', () => {
    const empty = createScore({ title: 'Empty', lengthBeats: 8 });
    const quantized = quantizeScore(empty);
    expect(quantized.notes).toHaveLength(0);
    expect(quantized.lengthBeats).toBe(0);
    expect(() => quantizeScore(empty, 0)).toThrow(/positive/);
  });
});
