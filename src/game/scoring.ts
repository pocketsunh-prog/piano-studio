/**
 * Pure scoring logic for the falling-notes practice game.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without a DOM, an audio engine or a clock.
 */

export type Judgement = 'perfect' | 'great' | 'good' | 'miss';

/** Hit windows in milliseconds, measured from the note's ideal hit time. */
export interface JudgementWindows {
  /** |offset| <= perfect -> Perfect. */
  perfect: number;
  /** |offset| <= great -> Great. */
  great: number;
  /** |offset| <= good -> Good. */
  good: number;
  /** A late press up to this offset is consumed as a Miss; later than this the note is auto-missed. */
  lateMiss: number;
}

export const HIT_WINDOWS: JudgementWindows = Object.freeze({
  perfect: 60,
  great: 110,
  good: 170,
  lateMiss: 220,
});

/**
 * Judge a key-press offset (positive = late) against the hit windows.
 *
 * Returns `null` when the press is too early: early presses beyond the Good
 * window are ignored so that a player can hover over a key without losing the
 * note they are about to play.
 */
export function judgeTiming(
  offsetMs: number,
  windows: JudgementWindows = HIT_WINDOWS,
): Judgement | null {
  if (!Number.isFinite(offsetMs)) return null;
  const abs = Math.abs(offsetMs);
  if (abs <= windows.perfect) return 'perfect';
  if (abs <= windows.great) return 'great';
  if (abs <= windows.good) return 'good';
  if (offsetMs > windows.good && offsetMs <= windows.lateMiss) return 'miss';
  return null;
}

/** True once a still-unhit note is too late to be playable. */
export function isPastLateWindow(offsetMs: number, windows: JudgementWindows = HIT_WINDOWS): boolean {
  return offsetMs > windows.lateMiss;
}

export interface JudgementCounts {
  perfect: number;
  great: number;
  good: number;
  miss: number;
}

export interface ScoreState {
  score: number;
  combo: number;
  maxCombo: number;
  counts: JudgementCounts;
  judged: number;
}

export const EMPTY_COUNTS: JudgementCounts = Object.freeze({
  perfect: 0,
  great: 0,
  good: 0,
  miss: 0,
});

export const EMPTY_SCORE_STATE: ScoreState = Object.freeze({
  score: 0,
  combo: 0,
  maxCombo: 0,
  counts: EMPTY_COUNTS,
  judged: 0,
});

/** Points awarded before the combo multiplier is applied. */
export const BASE_POINTS: Readonly<Record<Judgement, number>> = Object.freeze({
  perfect: 300,
  great: 200,
  good: 100,
  miss: 0,
});

/** Weight of each judgement in the accuracy percentage (misses are scored too). */
export const ACCURACY_WEIGHTS: Readonly<Record<Judgement, number>> = Object.freeze({
  perfect: 1,
  great: 0.65,
  good: 0.3,
  miss: 0,
});

export const COMBO_BONUS_STEP = 0.02;
export const COMBO_BONUS_CAP = 50;

/** Score multiplier earned by the current combo: 1x up to 2x at 50 combo. */
export function comboMultiplier(combo: number): number {
  const safe = Number.isFinite(combo) ? Math.max(0, Math.floor(combo)) : 0;
  return 1 + Math.min(safe, COMBO_BONUS_CAP) * COMBO_BONUS_STEP;
}

/** Points for a single judgement at the combo value *after* it was applied. */
export function pointsFor(judgement: Judgement, comboAfter: number): number {
  if (judgement === 'miss') return 0;
  return Math.round(BASE_POINTS[judgement] * comboMultiplier(comboAfter));
}

/** Immutable reducer: fold one judgement into the running score state. */
export function applyJudgement(state: ScoreState, judgement: Judgement): ScoreState {
  const counts: JudgementCounts = {
    ...state.counts,
    [judgement]: state.counts[judgement] + 1,
  };
  const hit = judgement !== 'miss';
  const combo = hit ? state.combo + 1 : 0;
  return {
    score: state.score + pointsFor(judgement, combo),
    combo,
    maxCombo: Math.max(state.maxCombo, combo),
    counts,
    judged: state.judged + 1,
  };
}

/** Accuracy as a 0..100 percentage; 100 while nothing has been judged. */
export function accuracyOf(state: ScoreState): number {
  if (state.judged <= 0) return 100;
  let weighted = 0;
  for (const key of ['perfect', 'great', 'good', 'miss'] as const) {
    weighted += state.counts[key] * ACCURACY_WEIGHTS[key];
  }
  return (weighted / state.judged) * 100;
}

/** Number of notes that were actually hit (anything but a miss). */
export function hitCount(state: ScoreState): number {
  return state.judged - state.counts.miss;
}

export type GameRank = 'S' | 'A' | 'B' | 'C' | 'D';

/** Letter grade shown on the results screen. */
export function rankOf(accuracy: number): GameRank {
  if (!Number.isFinite(accuracy)) return 'D';
  if (accuracy >= 95) return 'S';
  if (accuracy >= 88) return 'A';
  if (accuracy >= 78) return 'B';
  if (accuracy >= 65) return 'C';
  return 'D';
}

export interface GameResult {
  score: number;
  maxCombo: number;
  accuracy: number;
  rank: GameRank;
  counts: JudgementCounts;
  judged: number;
  totalNotes: number;
}

/** Snapshot for the results screen. */
export function buildResult(state: ScoreState, totalNotes: number): GameResult {
  const accuracy = accuracyOf(state);
  return {
    score: state.score,
    maxCombo: state.maxCombo,
    accuracy,
    rank: rankOf(accuracy),
    counts: { ...state.counts },
    judged: state.judged,
    totalNotes: Math.max(0, Math.floor(totalNotes)),
  };
}

/** Fraction (0..1) used by the progress bar. */
export function progressOf(judged: number, totalNotes: number): number {
  if (!Number.isFinite(judged) || !Number.isFinite(totalNotes) || totalNotes <= 0) return 0;
  return Math.min(1, Math.max(0, judged / totalNotes));
}
