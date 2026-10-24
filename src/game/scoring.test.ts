import { describe, expect, it } from 'vitest';
import {
  ACCURACY_WEIGHTS,
  BASE_POINTS,
  EMPTY_SCORE_STATE,
  HIT_WINDOWS,
  accuracyOf,
  applyJudgement,
  buildResult,
  comboMultiplier,
  hitCount,
  judgeTiming,
  pointsFor,
  progressOf,
  rankOf,
} from './scoring';
import type { Judgement, ScoreState } from './scoring';

function fold(judgements: Judgement[]): ScoreState {
  return judgements.reduce(applyJudgement, EMPTY_SCORE_STATE);
}

describe('judgeTiming', () => {
  it('grades the perfect window (<= 60 ms, early or late)', () => {
    expect(judgeTiming(0)).toBe('perfect');
    expect(judgeTiming(60)).toBe('perfect');
    expect(judgeTiming(-60)).toBe('perfect');
    expect(judgeTiming(60.5)).toBe('great');
  });

  it('grades the great window (<= 110 ms)', () => {
    expect(judgeTiming(61)).toBe('great');
    expect(judgeTiming(-110)).toBe('great');
    expect(judgeTiming(110.5)).toBe('good');
  });

  it('grades the good window (<= 170 ms)', () => {
    expect(judgeTiming(111)).toBe('good');
    expect(judgeTiming(-170)).toBe('good');
  });

  it('treats a very late press inside 170..220 ms as a consumed miss', () => {
    expect(judgeTiming(171)).toBe('miss');
    expect(judgeTiming(220)).toBe('miss');
  });

  it('ignores an early press and a press past the late window', () => {
    expect(judgeTiming(-171)).toBeNull();
    expect(judgeTiming(-500)).toBeNull();
    expect(judgeTiming(221)).toBeNull();
    expect(judgeTiming(Number.NaN)).toBeNull();
  });

  it('honours custom windows', () => {
    const tight = { perfect: 20, great: 40, good: 80, lateMiss: 120 };
    expect(judgeTiming(25, tight)).toBe('great');
    expect(judgeTiming(100, tight)).toBe('miss');
    expect(judgeTiming(-100, tight)).toBeNull();
    expect(HIT_WINDOWS.lateMiss).toBe(220);
  });
});

describe('comboMultiplier', () => {
  it('starts at 1x and caps at 2x after 50 combo', () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(1)).toBeCloseTo(1.02, 10);
    expect(comboMultiplier(25)).toBeCloseTo(1.5, 10);
    expect(comboMultiplier(50)).toBe(2);
    expect(comboMultiplier(500)).toBe(2);
    expect(comboMultiplier(-3)).toBe(1);
    expect(comboMultiplier(Number.NaN)).toBe(1);
  });

  it('is monotonic over the combo range', () => {
    let previous = comboMultiplier(0);
    for (let combo = 1; combo <= 80; combo += 1) {
      const value = comboMultiplier(combo);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe('applyJudgement', () => {
  it('does not mutate the input state', () => {
    const before = fold(['perfect']);
    const snapshot = JSON.parse(JSON.stringify(before)) as ScoreState;
    applyJudgement(before, 'miss');
    expect(before).toEqual(snapshot);
  });

  it('accumulates score with the multiplier of the new combo', () => {
    const first = applyJudgement(EMPTY_SCORE_STATE, 'perfect');
    expect(first.combo).toBe(1);
    expect(first.maxCombo).toBe(1);
    expect(first.score).toBe(pointsFor('perfect', 1));
    expect(first.score).toBe(Math.round(BASE_POINTS.perfect * 1.02));

    const second = applyJudgement(first, 'perfect');
    expect(second.combo).toBe(2);
    expect(second.score).toBe(first.score + Math.round(BASE_POINTS.perfect * 1.04));
    expect(second.judged).toBe(2);
  });

  it('counts each judgement and resets the combo on a miss', () => {
    const state = fold(['perfect', 'great', 'good', 'perfect', 'miss', 'perfect']);
    expect(state.counts).toEqual({ perfect: 3, great: 1, good: 1, miss: 1 });
    expect(state.judged).toBe(6);
    expect(state.combo).toBe(1);
    expect(state.maxCombo).toBe(4);
    expect(hitCount(state)).toBe(5);
  });

  it('gives a miss no points', () => {
    const state = applyJudgement(fold(['perfect']), 'miss');
    expect(state.score).toBe(Math.round(BASE_POINTS.perfect * 1.02));
    expect(state.combo).toBe(0);
  });
});

describe('accuracyOf', () => {
  it('is 100 before anything is judged', () => {
    expect(accuracyOf(EMPTY_SCORE_STATE)).toBe(100);
  });

  it('is 100 for all perfects and 0 for all misses', () => {
    expect(accuracyOf(fold(['perfect', 'perfect']))).toBe(100);
    expect(accuracyOf(fold(['miss', 'miss']))).toBe(0);
  });

  it('weights great/good/miss judgements', () => {
    const state = fold(['great', 'good', 'miss']);
    const expected = ((ACCURACY_WEIGHTS.great + ACCURACY_WEIGHTS.good + 0) / 3) * 100;
    expect(accuracyOf(state)).toBeCloseTo(expected, 10);
  });

  it('never exceeds 0..100', () => {
    const many = fold(Array.from({ length: 40 }, () => 'perfect' as const));
    expect(accuracyOf(many)).toBe(100);
  });
});

describe('rankOf', () => {
  it('maps accuracy to letter grades', () => {
    expect(rankOf(100)).toBe('S');
    expect(rankOf(95)).toBe('S');
    expect(rankOf(94.9)).toBe('A');
    expect(rankOf(88)).toBe('A');
    expect(rankOf(78)).toBe('B');
    expect(rankOf(65)).toBe('C');
    expect(rankOf(64.9)).toBe('D');
    expect(rankOf(Number.NaN)).toBe('D');
  });
});

describe('progressOf', () => {
  it('clamps to 0..1 and tolerates an empty score', () => {
    expect(progressOf(0, 10)).toBe(0);
    expect(progressOf(5, 10)).toBe(0.5);
    expect(progressOf(20, 10)).toBe(1);
    expect(progressOf(0, 0)).toBe(0);
    expect(progressOf(Number.NaN, 10)).toBe(0);
  });
});

describe('buildResult', () => {
  it('summarises a finished run', () => {
    const state = fold(['perfect', 'perfect', 'great', 'miss']);
    const result = buildResult(state, 4);
    expect(result.score).toBe(state.score);
    expect(result.maxCombo).toBe(3);
    expect(result.counts).toEqual(state.counts);
    expect(result.judged).toBe(4);
    expect(result.totalNotes).toBe(4);
    expect(result.accuracy).toBeCloseTo(accuracyOf(state), 10);
    expect(result.rank).toBe(rankOf(accuracyOf(state)));
  });
});
