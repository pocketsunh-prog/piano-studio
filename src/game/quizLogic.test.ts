import { describe, expect, it } from 'vitest';
import {
  QUIZ_BONUS_WINDOW_MS,
  QUIZ_BASE_POINTS,
  QUIZ_HIGH_MIDI,
  QUIZ_KEYBOARD_HIGH_MIDI,
  QUIZ_KEYBOARD_LOW_MIDI,
  QUIZ_LOW_MIDI,
  QUIZ_MAX_TIME_BONUS,
  QUIZ_ROUNDS,
  buildQuizKeyboard,
  generateQuizRun,
  isQuizCorrect,
  mulberry32,
  quizPoints,
  quizPool,
  roundNoteName,
  summarizeQuiz,
  validateQuizRun,
} from './quizLogic';
import type { QuizAnswer, QuizRound } from './quizLogic';

describe('mulberry32', () => {
  it('is deterministic for a seed and yields values in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 20; i += 1) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('produces a different sequence for a different seed', () => {
    const a = Array.from({ length: 8 }, mulberry32(7));
    const b = Array.from({ length: 8 }, mulberry32(8));
    expect(a).not.toEqual(b);
  });
});

describe('quizPool', () => {
  it('contains every note from C4 to C5 inclusive', () => {
    const pool = quizPool();
    expect(pool).toHaveLength(QUIZ_HIGH_MIDI - QUIZ_LOW_MIDI + 1);
    expect(pool[0]).toBe(60);
    expect(pool[pool.length - 1]).toBe(72);
    expect(roundNoteName({ index: 0, midi: 60, mode: 'ear' })).toBe('C4');
    expect(roundNoteName({ index: 0, midi: 72, mode: 'ear' })).toBe('C5');
  });
});

describe('generateQuizRun', () => {
  it('generates 10 rounds in the requested mode and target range', () => {
    const rounds = generateQuizRun('ear', { seed: 123 });
    expect(rounds).toHaveLength(QUIZ_ROUNDS);
    rounds.forEach((round, index) => {
      expect(round.index).toBe(index);
      expect(round.mode).toBe('ear');
      expect(round.midi).toBeGreaterThanOrEqual(QUIZ_LOW_MIDI);
      expect(round.midi).toBeLessThanOrEqual(QUIZ_HIGH_MIDI);
      expect(Number.isInteger(round.midi)).toBe(true);
    });
    expect(validateQuizRun(rounds)).toEqual([]);
  });

  it('never repeats the same target back-to-back', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const rounds = generateQuizRun('find', { seed });
      for (let i = 1; i < rounds.length; i += 1) {
        expect(rounds[i].midi).not.toBe(rounds[i - 1].midi);
      }
    }
  });

  it('is deterministic for the same seed', () => {
    expect(generateQuizRun('ear', { seed: 99 })).toEqual(generateQuizRun('ear', { seed: 99 }));
  });

  it('varies with the seed', () => {
    const a = generateQuizRun('ear', { seed: 1 }).map((round) => round.midi);
    const b = generateQuizRun('ear', { seed: 2 }).map((round) => round.midi);
    expect(a).not.toEqual(b);
  });

  it('still avoids repeats when the RNG always returns zero', () => {
    const rounds = generateQuizRun('ear', { rounds: 4, rng: () => 0, pool: [60, 61, 62] });
    expect(rounds.map((round) => round.midi)).toEqual([60, 61, 60, 61]);
  });

  it('supports a custom round count and pool', () => {
    const rounds = generateQuizRun('find', { rounds: 3, rng: mulberry32(5), pool: [64, 65] });
    expect(rounds).toHaveLength(3);
    rounds.forEach((round) => expect([64, 65]).toContain(round.midi));
  });

  it('rejects an empty pool', () => {
    expect(() => generateQuizRun('ear', { pool: [] })).toThrow(/at least one playable note/);
  });
});

describe('validateQuizRun', () => {
  it('reports structural problems', () => {
    const bad: QuizRound[] = [
      { index: 3, midi: 90, mode: 'ear' },
      { index: 1, midi: 60, mode: 'ear' },
    ];
    const errors = validateQuizRun(bad, 2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.join(' ')).toMatch(/out-of-range/);
    expect(errors.join(' ')).toMatch(/index/);
  });

  it('flags a wrong round count', () => {
    expect(validateQuizRun(generateQuizRun('ear', { seed: 1 }), 8)).toHaveLength(1);
  });
});

describe('isQuizCorrect', () => {
  const round: QuizRound = { index: 0, midi: 64, mode: 'find' };

  it('requires the exact key, not just the pitch class', () => {
    expect(isQuizCorrect(round, 64)).toBe(true);
    expect(isQuizCorrect(round, 76)).toBe(false);
    expect(isQuizCorrect(round, 63)).toBe(false);
  });
});

describe('quizPoints', () => {
  it('awards base points plus a speed bonus', () => {
    expect(quizPoints(true, 0)).toBe(QUIZ_BASE_POINTS + QUIZ_MAX_TIME_BONUS);
    expect(quizPoints(true, QUIZ_BONUS_WINDOW_MS / 2)).toBe(
      QUIZ_BASE_POINTS + Math.round(QUIZ_MAX_TIME_BONUS / 2),
    );
    expect(quizPoints(true, QUIZ_BONUS_WINDOW_MS)).toBe(QUIZ_BASE_POINTS);
    expect(quizPoints(true, 99_999)).toBe(QUIZ_BASE_POINTS);
    expect(quizPoints(true, -50)).toBe(QUIZ_BASE_POINTS + QUIZ_MAX_TIME_BONUS);
  });

  it('scores nothing for a wrong answer', () => {
    expect(quizPoints(false, 0)).toBe(0);
  });
});

describe('summarizeQuiz', () => {
  it('aggregates correct/wrong, streak, score and average time', () => {
    const answers: QuizAnswer[] = [
      { roundIndex: 0, targetMidi: 60, playedMidi: 60, mode: 'ear', correct: true, elapsedMs: 500, points: 142 },
      { roundIndex: 1, targetMidi: 62, playedMidi: 62, mode: 'ear', correct: true, elapsedMs: 1500, points: 125 },
      { roundIndex: 2, targetMidi: 64, playedMidi: 65, mode: 'ear', correct: false, elapsedMs: 4000, points: 0 },
      { roundIndex: 3, targetMidi: 65, playedMidi: 65, mode: 'ear', correct: true, elapsedMs: 1000, points: 133 },
      { roundIndex: 4, targetMidi: 67, playedMidi: 67, mode: 'ear', correct: true, elapsedMs: 1000, points: 133 },
    ];
    const summary = summarizeQuiz(answers);
    expect(summary.rounds).toBe(5);
    expect(summary.correct).toBe(4);
    expect(summary.wrong).toBe(1);
    expect(summary.accuracy).toBe(80);
    expect(summary.score).toBe(142 + 125 + 133 + 133);
    expect(summary.bestStreak).toBe(2);
    expect(summary.averageMs).toBe((500 + 1500 + 4000 + 1000 + 1000) / 5);
    expect(summary.rank).toBe('B');
  });

  it('derives points when an answer has none', () => {
    const summary = summarizeQuiz([{ correct: true, elapsedMs: 0 }]);
    expect(summary.score).toBe(QUIZ_BASE_POINTS + QUIZ_MAX_TIME_BONUS);
  });

  it('handles an empty answer list', () => {
    const summary = summarizeQuiz([]);
    expect(summary.correct).toBe(0);
    expect(summary.accuracy).toBe(100);
    expect(summary.bestStreak).toBe(0);
    expect(summary.averageMs).toBe(0);
    expect(summary.rank).toBe('S');
  });
});

describe('buildQuizKeyboard', () => {
  it('lays out two octaves with the correct white/black positions', () => {
    const keys = buildQuizKeyboard();
    expect(keys[0].midi).toBe(QUIZ_KEYBOARD_LOW_MIDI);
    expect(keys[keys.length - 1].midi).toBe(QUIZ_KEYBOARD_HIGH_MIDI);
    expect(keys).toHaveLength(QUIZ_KEYBOARD_HIGH_MIDI - QUIZ_KEYBOARD_LOW_MIDI + 1);
    expect(keys.filter((key) => key.black)).toHaveLength(10);
    expect(keys.filter((key) => !key.black)).toHaveLength(14);

    const c4 = keys.find((key) => key.name === 'C4');
    const cSharp4 = keys.find((key) => key.name === 'C#4');
    const d4 = keys.find((key) => key.name === 'D4');
    const e4 = keys.find((key) => key.name === 'E4');
    expect(c4?.whiteIndex).toBe(0);
    expect(cSharp4?.whiteIndex).toBe(0);
    expect(d4?.whiteIndex).toBe(1);
    expect(e4?.whiteIndex).toBe(2);
    expect(keys[keys.length - 1].name).toBe('B5');
    expect(keys[keys.length - 1].whiteIndex).toBe(13);
  });
});
