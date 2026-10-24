import { describe, expect, it } from 'vitest';
import {
  beatToSeconds,
  buildMeasures,
  measureBeats,
  scoreDurationSeconds,
  secondsToBeat,
  tempoAt,
  timeSignatureAt,
} from './timing';
import type { Score } from './types';

function makeScore(overrides: Partial<Score> = {}): Score {
  return {
    id: 'test',
    title: 'Test',
    composer: '',
    notes: [],
    tempo: [{ beat: 0, bpm: 120 }],
    timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }],
    keySignature: { fifths: 0, mode: 'major' },
    ppq: 480,
    source: 'builtin',
    lengthBeats: 8,
    ...overrides,
  };
}

describe('tempo mapping', () => {
  it('converts beats to seconds at a constant tempo', () => {
    const score = makeScore();
    expect(beatToSeconds(score, 0)).toBe(0);
    expect(beatToSeconds(score, 1)).toBeCloseTo(0.5, 9);
    expect(beatToSeconds(score, 8)).toBeCloseTo(4, 9);
    expect(scoreDurationSeconds(score)).toBeCloseTo(4, 9);
  });

  it('integrates tempo changes', () => {
    const score = makeScore({
      tempo: [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 60 },
      ],
      lengthBeats: 8,
    });
    expect(beatToSeconds(score, 4)).toBeCloseTo(2, 9);
    expect(beatToSeconds(score, 8)).toBeCloseTo(6, 9);
    expect(tempoAt(score, 3.9)).toBe(120);
    expect(tempoAt(score, 4)).toBe(60);
  });

  it('inverts secondsToBeat across tempo changes', () => {
    const score = makeScore({
      tempo: [
        { beat: 0, bpm: 90 },
        { beat: 2, bpm: 140 },
        { beat: 6, bpm: 60 },
      ],
      lengthBeats: 10,
    });
    for (const beat of [0, 0.5, 2, 3.25, 6, 7.75, 10]) {
      expect(secondsToBeat(score, beatToSeconds(score, beat))).toBeCloseTo(beat, 9);
    }
  });
});

describe('measures', () => {
  it('splits 4/4 into four-beat measures', () => {
    const score = makeScore({ lengthBeats: 10 });
    const measures = buildMeasures(score);
    expect(measures.length).toBe(3);
    expect(measures[0]).toMatchObject({ index: 0, start: 0, end: 4 });
    expect(measures[1]).toMatchObject({ index: 1, start: 4, end: 8 });
    expect(measures[2].end).toBe(12); // the final bar is completed to a full 4/4 measure
    expect(measureBeats({ numerator: 3, denominator: 8 })).toBeCloseTo(1.5, 9);
  });

  it('honours time-signature changes at their beat', () => {
    const score = makeScore({
      lengthBeats: 10,
      timeSignatures: [
        { beat: 0, numerator: 4, denominator: 4 },
        { beat: 4, numerator: 3, denominator: 4 },
      ],
    });
    const measures = buildMeasures(score);
    expect(measures[0].end).toBe(4);
    expect(measures[1].start).toBe(4);
    expect(measures[1].end).toBe(7);
    expect(measures[1].timeSignature.numerator).toBe(3);
    expect(timeSignatureAt(score, 6).numerator).toBe(3);
    expect(timeSignatureAt(score, 2).numerator).toBe(4);
  });

  it('starts a new measure early when a signature change is mid-bar', () => {
    const score = makeScore({
      lengthBeats: 8,
      timeSignatures: [
        { beat: 0, numerator: 4, denominator: 4 },
        { beat: 3, numerator: 2, denominator: 4 },
      ],
    });
    const measures = buildMeasures(score);
    expect(measures[0].end).toBe(3);
    expect(measures[1].start).toBe(3);
    expect(measures[1].end).toBe(5);
  });
});
