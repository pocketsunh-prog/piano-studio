import { describe, expect, it } from 'vitest';
import { createScore, normalizeScore, notesEndBeat, subsetScore, transposeScore } from './score';
import type { NoteEvent, Score } from './types';

function note(partial: Partial<NoteEvent> & Pick<NoteEvent, 'midi' | 'start' | 'duration'>): NoteEvent {
  return {
    id: partial.id ?? `n-${partial.midi}-${partial.start}`,
    midi: partial.midi,
    start: partial.start,
    duration: partial.duration,
    velocity: partial.velocity ?? 80,
    hand: partial.hand ?? (partial.midi < 60 ? 'left' : 'right'),
  };
}

describe('normalizeScore', () => {
  it('sorts notes, fills defaults and computes length', () => {
    const score: Score = {
      id: 'x',
      title: 'X',
      composer: '',
      notes: [note({ midi: 64, start: 2, duration: 1 }), note({ midi: 60, start: 0, duration: 4 })],
      tempo: [],
      timeSignatures: [],
      keySignature: { fifths: 0, mode: 'major' },
      ppq: 0,
      source: 'builtin',
      lengthBeats: 0,
    };
    const normalized = normalizeScore(score);
    expect(normalized.notes.map((value) => value.midi)).toEqual([60, 64]);
    expect(normalized.tempo[0]).toEqual({ beat: 0, bpm: 120 });
    expect(normalized.timeSignatures[0]).toEqual({ beat: 0, numerator: 4, denominator: 4 });
    expect(normalized.lengthBeats).toBe(4);
    expect(normalized.ppq).toBe(480);
    expect(notesEndBeat(normalized.notes)).toBe(4);
  });

  it('clamps pitches and durations and de-duplicates ids', () => {
    const normalized = normalizeScore(
      createScore({
        notes: [
          note({ midi: 200, start: -2, duration: 0.5, id: 'same' }),
          note({ midi: -5, start: 1, duration: 1, id: 'same' }),
        ],
      }),
    );
    expect(normalized.notes[0].midi).toBe(108);
    expect(normalized.notes[1].midi).toBe(21);
    expect(normalized.notes[0].start).toBe(0);
    expect(normalized.notes[0].duration).toBeGreaterThan(0);
    expect(new Set(normalized.notes.map((value) => value.id)).size).toBe(2);

    const withZero = normalizeScore(
      createScore({ notes: [note({ midi: 60, start: 0, duration: 0 })] }),
    );
    expect(withZero.notes).toHaveLength(0);
  });
});

describe('score transforms', () => {
  const score = createScore({
    notes: [
      note({ midi: 60, start: 0, duration: 2 }),
      note({ midi: 64, start: 2, duration: 2 }),
      note({ midi: 67, start: 4, duration: 2 }),
    ],
    lengthBeats: 6,
  });

  it('transposes and keeps notes in range', () => {
    const up = transposeScore(score, 3);
    expect(up.notes.map((value) => value.midi)).toEqual([63, 67, 70]);
    const extreme = transposeScore(score, 80);
    expect(extreme.notes.length).toBe(0);
    expect(extreme.lengthBeats).toBe(0);
  });

  it('extracts a beat range and rebases it', () => {
    const part = subsetScore(score, 2, 6);
    expect(part.notes.map((value) => value.start)).toEqual([0, 2]);
    expect(part.lengthBeats).toBe(4);
    expect(part.notes[0].midi).toBe(64);
  });
});
