/**
 * Pure logic for the ear-training / key-finding quiz.
 *
 * Round generation is deterministic for a given seed so it can be validated in
 * tests; the UI seeds it from the clock.
 */

import { midiToName } from '../music/pitch';
import { rankOf, type GameRank } from './scoring';

export type QuizMode = 'ear' | 'find';

/** "Hear the note": the engine plays a note, the player finds the matching key. */
export const QUIZ_MODE_LABELS: Readonly<Record<QuizMode, string>> = Object.freeze({
  ear: 'Hear the note',
  find: 'Find the key',
});

/** Rounds in one practice run. */
export const QUIZ_ROUNDS = 10;

/** Target notes are always inside C4..C5 (inclusive). */
export const QUIZ_LOW_MIDI = 60;
export const QUIZ_HIGH_MIDI = 72;

/** The on-screen keyboard spans two octaves: C4..B5. */
export const QUIZ_KEYBOARD_LOW_MIDI = 60;
export const QUIZ_KEYBOARD_HIGH_MIDI = 83;

/** Base points for a correct answer plus the maximum timing bonus. */
export const QUIZ_BASE_POINTS = 100;
export const QUIZ_MAX_TIME_BONUS = 50;
/** Bonus decays linearly to zero over this many milliseconds. */
export const QUIZ_BONUS_WINDOW_MS = 3000;

export interface QuizRound {
  /** 0-based round index. */
  index: number;
  /** Target MIDI note (C4..C5). */
  midi: number;
  mode: QuizMode;
}

export interface QuizAnswer {
  roundIndex: number;
  targetMidi: number;
  playedMidi: number;
  mode: QuizMode;
  correct: boolean;
  /** Response time in milliseconds. */
  elapsedMs: number;
  points: number;
}

export interface QuizSummary {
  rounds: number;
  correct: number;
  wrong: number;
  accuracy: number;
  score: number;
  bestStreak: number;
  averageMs: number;
  rank: GameRank;
}

/** Deterministic 32-bit PRNG (mulberry32): returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every possible target note, ascending: C4, C#4 … C5. */
export function quizPool(): number[] {
  const pool: number[] = [];
  for (let midi = QUIZ_LOW_MIDI; midi <= QUIZ_HIGH_MIDI; midi += 1) pool.push(midi);
  return pool;
}

export interface QuizRunOptions {
  rounds?: number;
  seed?: number;
  /** Custom RNG, e.g. for tests. Takes precedence over `seed`. */
  rng?: () => number;
  /** Custom target pool (must contain at least one MIDI note). */
  pool?: readonly number[];
}

/**
 * Build a full run of rounds. Never repeats the same target back-to-back when
 * the pool allows it, and is deterministic for a given seed / RNG.
 */
export function generateQuizRun(mode: QuizMode, options: QuizRunOptions = {}): QuizRound[] {
  const total = Math.max(1, Math.floor(options.rounds ?? QUIZ_ROUNDS));
  const sourcePool = options.pool ? [...options.pool] : quizPool();
  const pool = sourcePool
    .filter((midi) => Number.isFinite(midi))
    .map((midi) => Math.round(midi));
  if (pool.length === 0) {
    throw new Error('Quiz round generation needs at least one playable note.');
  }
  const rng = options.rng ?? mulberry32(options.seed ?? Date.now());
  const rounds: QuizRound[] = [];
  let previous = -1;

  for (let index = 0; index < total; index += 1) {
    let pick = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
    // Avoid an immediate repeat: step to the next note in the pool.
    if (pool.length > 1 && pool[pick] === previous) {
      pick = (pick + 1) % pool.length;
    }
    previous = pool[pick];
    rounds.push({ index, midi: pool[pick], mode });
  }
  return rounds;
}

/** Structural sanity check used defensively before a run starts. */
export function validateQuizRun(rounds: readonly QuizRound[], expectedRounds = QUIZ_ROUNDS): string[] {
  const errors: string[] = [];
  if (rounds.length !== expectedRounds) {
    errors.push(`Expected ${expectedRounds} rounds, got ${rounds.length}.`);
  }
  rounds.forEach((round, index) => {
    if (round.index !== index) errors.push(`Round ${index} has index ${round.index}.`);
    if (round.mode !== 'ear' && round.mode !== 'find') errors.push(`Round ${index} has an unknown mode.`);
    if (
      !Number.isFinite(round.midi) ||
      round.midi < QUIZ_LOW_MIDI ||
      round.midi > QUIZ_HIGH_MIDI
    ) {
      errors.push(`Round ${index} has an out-of-range MIDI note.`);
    }
  });
  return errors;
}

/** A round is answered correctly by pressing exactly the target key. */
export function isQuizCorrect(round: QuizRound, pressedMidi: number): boolean {
  return Math.round(pressedMidi) === round.midi;
}

/** Human note name for a MIDI number, e.g. 62 -> "D4". */
export function roundNoteName(round: QuizRound): string {
  return midiToName(round.midi);
}

/**
 * Points for an answer: 100 for a correct answer plus up to 50 for speed.
 * Wrong answers score 0 (the run tracks the streak separately).
 */
export function quizPoints(correct: boolean, elapsedMs: number): number {
  if (!correct) return 0;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const remaining = 1 - Math.min(1, elapsed / QUIZ_BONUS_WINDOW_MS);
  return QUIZ_BASE_POINTS + Math.round(QUIZ_MAX_TIME_BONUS * remaining);
}

export interface QuizAnswerInput {
  correct: boolean;
  elapsedMs: number;
  points?: number;
}

/** Aggregate answers into the results-screen summary. */
export function summarizeQuiz(
  answers: readonly QuizAnswerInput[],
  expectedRounds = QUIZ_ROUNDS,
): QuizSummary {
  const rounds = answers.length;
  let correct = 0;
  let score = 0;
  let elapsedTotal = 0;
  let streak = 0;
  let bestStreak = 0;

  for (const answer of answers) {
    score += Number.isFinite(answer.points)
      ? (answer.points as number)
      : quizPoints(answer.correct, answer.elapsedMs);
    const ms = Number.isFinite(answer.elapsedMs) ? Math.max(0, answer.elapsedMs) : 0;
    elapsedTotal += ms;
    if (answer.correct) {
      correct += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else {
      streak = 0;
    }
  }

  const wrong = rounds - correct;
  const accuracy = rounds > 0 ? (correct / rounds) * 100 : 100;
  return {
    rounds: rounds > 0 ? rounds : Math.max(0, expectedRounds),
    correct,
    wrong,
    accuracy,
    score,
    bestStreak,
    averageMs: rounds > 0 ? elapsedTotal / rounds : 0,
    rank: rankOf(accuracy),
  };
}

/** Keyboard layout for the quiz (two octaves), used by the on-screen keys. */
export interface QuizKeyDef {
  midi: number;
  name: string;
  black: boolean;
  /** Index among white keys (for black keys: the white key to its left). */
  whiteIndex: number;
}

const WHITE_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);

export function buildQuizKeyboard(
  lowMidi = QUIZ_KEYBOARD_LOW_MIDI,
  highMidi = QUIZ_KEYBOARD_HIGH_MIDI,
): QuizKeyDef[] {
  const keys: QuizKeyDef[] = [];
  let whiteCount = 0;
  for (let midi = Math.max(0, lowMidi); midi <= Math.min(127, highMidi); midi += 1) {
    const pc = ((midi % 12) + 12) % 12;
    const black = !WHITE_PITCH_CLASSES.has(pc);
    keys.push({
      midi,
      name: midiToName(midi),
      black,
      whiteIndex: black ? Math.max(0, whiteCount - 1) : whiteCount,
    });
    if (!black) whiteCount += 1;
  }
  return keys;
}
