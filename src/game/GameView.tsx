/**
 * Falling-notes practice game.
 *
 * Notes fall in twelve chromatic pitch lanes towards a hit line. The player
 * answers with the on-screen lane strip or the shared QWERTY mapping; the lane
 * is matched by note name (octave shift only changes the register of the sound
 * the player produces). Rendering is a single imperative canvas driven by one
 * requestAnimationFrame loop, with a throttled DOM HUD on top.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PianoEngine } from '../audio/PianoEngine';
import type { NoteEvent, Score } from '../music/types';
import { beatToSeconds, buildMeasures, clampMidi, tempoAt } from '../music/timing';
import { PITCH_NAMES, midiToName } from '../music/pitch';
import {
  MAX_OCTAVE,
  MIN_OCTAVE,
  QWERTY_KEYMAP,
  octaveBaseMidi,
  qwertyLabelForMidi,
} from '../music/keymap';
import {
  EMPTY_SCORE_STATE,
  HIT_WINDOWS,
  accuracyOf,
  applyJudgement,
  buildResult,
  comboMultiplier,
  judgeTiming,
  progressOf,
  type GameResult,
  type Judgement,
  type ScoreState,
} from './scoring';
import './GameView.css';

export interface GameViewProps {
  score: Score;
  engine: PianoEngine;
  onExit: () => void;
  onActiveKeysChange?: (midis: number[]) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LANE_COUNT = 12;
const BLACK_LANES: ReadonlySet<number> = new Set([1, 3, 6, 8, 10]);
const COUNT_IN_BEATS = 4;
const COUNT_IN_MIN_MS = 900;
/**
 * Breathing room between the count-in and the first note: the run is already
 * "playing" (and the HUD live) but the first note only reaches the hit line
 * after this runway, so nobody starts with unavoidable misses.
 */
const NOTE_LEAD_MS = 1000;
const APPROACH_SEC = 2.4;
const SHORT_SECONDS = 24;
const FULL_SECONDS = 90;
const MAX_HIT_NOTES = 260;
const ASSIST_LOOKAHEAD_MS = 1400;
const GUIDE_LOOKAHEAD_MS = 500;
const RESUME_LEAD_MS = 1200;
const HUD_INTERVAL_MS = 90;
const POPUP_LIFE_MS = 700;
const KEYBED_FALLBACK_H = 92;
const KEY_HINT_LETTER = buildLaneLetters();
const JUDGEMENT_LABEL: Readonly<Record<Judgement, string>> = {
  perfect: 'Perfect',
  great: 'Great',
  good: 'Good',
  miss: 'Miss',
};
const CANVAS_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

type GamePhase = 'idle' | 'countin' | 'playing' | 'paused' | 'results';
type LengthMode = 'short' | 'full';

interface GameOptions {
  length: LengthMode;
  tempoScale: number;
  guide: boolean;
  assist: boolean;
}

interface HitNote {
  id: string;
  lane: number;
  /** Onset in score seconds (tempo 1x). */
  startPerf: number;
  durationPerf: number;
  midis: number[];
  names: string[];
  state: 'pending' | 'hit' | 'missed';
  judgement?: Judgement;
}

interface BeatTick {
  perf: number;
  accent: boolean;
}

interface PreparedGame {
  notes: HitNote[];
  duration: number;
  bpm: number;
  beatTicks: BeatTick[];
  totalSourceNotes: number;
  truncated: boolean;
}

interface Popup {
  text: string;
  color: string;
  lane: number;
  wall: number;
  big: boolean;
}

interface HeldInput {
  lane: number;
  midi: number;
}

interface Run {
  phase: GamePhase;
  notes: HitNote[];
  beatTicks: BeatTick[];
  musicStartWall: number;
  countInStartWall: number;
  countInMs: number;
  tempoScale: number;
  stats: ScoreState;
  judged: number;
  totalNotes: number;
  duration: number;
  missCursor: number;
  assistCursor: number;
  beatCursor: number;
  guideScheduled: Set<string>;
  activeInputs: Map<string, HeldInput>;
  laneFlashes: Map<number, number>;
  popups: Popup[];
  pauseWall: number;
  lastJudgedWall: number;
  allJudgedWall: number;
}

interface HudState {
  score: number;
  combo: number;
  maxCombo: number;
  accuracy: number;
  perfect: number;
  great: number;
  good: number;
  miss: number;
  judged: number;
  total: number;
  progress: number;
  countIn: number;
}

interface Geometry {
  width: number;
  height: number;
  laneW: number;
  topY: number;
  hitY: number;
  keybedTop: number;
}

interface Palette {
  bg: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accent2: string;
  perfect: string;
  great: string;
  good: string;
  miss: string;
}

const EMPTY_HUD: HudState = {
  score: 0,
  combo: 0,
  maxCombo: 0,
  accuracy: 100,
  perfect: 0,
  great: 0,
  good: 0,
  miss: 0,
  judged: 0,
  total: 0,
  progress: 0,
  countIn: 0,
};

const FALLBACK_PALETTE: Palette = {
  bg: '#0b0e14',
  border: '#26303f',
  text: '#e8edf5',
  muted: '#8d99ad',
  accent: '#e0b64c',
  accent2: '#63b3ed',
  perfect: '#ffd166',
  great: '#7ee787',
  good: '#79c0ff',
  miss: '#ff7b72',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function buildLaneLetters(): string[] {
  const letters: string[] = Array.from({ length: LANE_COUNT }, () => '');
  for (const [letter, semitone] of Object.entries(QWERTY_KEYMAP)) {
    const lane = ((semitone % 12) + 12) % 12;
    if (semitone >= 0 && semitone < LANE_COUNT && !letters[lane]) {
      letters[lane] = letter.toUpperCase();
    }
  }
  return letters;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function safeAudio(action: () => void): void {
  try {
    action();
  } catch {
    // A disposed / unavailable AudioContext must never break the game.
  }
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function laneOfMidi(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

function noteWall(run: Run, note: HitNote): number {
  return run.musicStartWall + (note.startPerf * 1000) / run.tempoScale;
}

function runPerf(run: Run, wall: number): number {
  return ((wall - run.musicStartWall) / 1000) * run.tempoScale;
}

function readPalette(): Palette {
  if (typeof window === 'undefined') return FALLBACK_PALETTE;
  const styles = window.getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    bg: read('--bg', FALLBACK_PALETTE.bg),
    border: read('--border', FALLBACK_PALETTE.border),
    text: read('--text', FALLBACK_PALETTE.text),
    muted: read('--muted', FALLBACK_PALETTE.muted),
    accent: read('--accent', FALLBACK_PALETTE.accent),
    accent2: read('--accent-2', FALLBACK_PALETTE.accent2),
    perfect: read('--perfect', FALLBACK_PALETTE.perfect),
    great: read('--great', FALLBACK_PALETTE.great),
    good: read('--good', FALLBACK_PALETTE.good),
    miss: read('--miss', FALLBACK_PALETTE.miss),
  };
}

function scheduleClickAt(engine: PianoEngine, wallMs: number, accent: boolean): void {
  safeAudio(() => {
    const audioNow = engine.now();
    const when = audioNow + Math.max(0.005, (wallMs - performance.now()) / 1000);
    engine.metronomeClick(when, accent);
  });
}

// ---------------------------------------------------------------------------
// Score preparation (pure)
// ---------------------------------------------------------------------------

function prepareGame(score: Score, length: LengthMode): PreparedGame {
  const limitSec = length === 'short' ? SHORT_SECONDS : FULL_SECONDS;
  const sourceNotes = score.notes
    .filter(
      (note) =>
        Number.isFinite(note.start) &&
        Number.isFinite(note.duration) &&
        note.duration > 0 &&
        Number.isFinite(note.midi),
    )
    .slice()
    .sort((a, b) => a.start - b.start || a.midi - b.midi);

  const chosen: { note: NoteEvent; startPerf: number; endPerf: number }[] = [];
  let duration = 0;
  for (const note of sourceNotes) {
    const startBeat = Math.max(0, note.start);
    const startPerf = Math.max(0, beatToSeconds(score, startBeat));
    if (startPerf > limitSec) break;
    const endPerf = Math.max(
      startPerf + 0.05,
      beatToSeconds(score, startBeat + Math.max(0.01, note.duration)),
    );
    chosen.push({ note, startPerf, endPerf });
    duration = Math.max(duration, endPerf);
    if (chosen.length >= MAX_HIT_NOTES) break;
  }

  // Merge simultaneous notes that share a pitch class into one hit object.
  const notes: HitNote[] = [];
  let bucketStart = Number.NEGATIVE_INFINITY;
  let laneGroups = new Map<number, HitNote>();
  for (const item of chosen) {
    const lane = laneOfMidi(item.note.midi);
    if (Math.abs(item.startPerf - bucketStart) > 0.02) {
      bucketStart = item.startPerf;
      laneGroups = new Map();
    }
    const group = laneGroups.get(lane);
    if (group) {
      if (!group.midis.includes(item.note.midi)) group.midis.push(item.note.midi);
      group.names.push(midiToName(item.note.midi));
      group.durationPerf = Math.max(group.durationPerf, item.endPerf - item.startPerf);
    } else {
      const created: HitNote = {
        id: `${item.note.id}:${notes.length}`,
        lane,
        startPerf: item.startPerf,
        durationPerf: item.endPerf - item.startPerf,
        midis: [item.note.midi],
        names: [midiToName(item.note.midi)],
        state: 'pending',
      };
      laneGroups.set(lane, created);
      notes.push(created);
    }
  }
  notes.sort((a, b) => a.startPerf - b.startPerf || a.lane - b.lane);
  for (const note of notes) note.names = Array.from(new Set(note.names));

  // Beat grid for the visual rhythm + optional guide metronome.
  const beatTicks: BeatTick[] = [];
  const beats = buildMeasures(score, 2000);
  const hardLimit = Math.min(duration + 2, FULL_SECONDS + 4);
  outer: for (const measure of beats) {
    let beat = measure.start;
    let beatInMeasure = 0;
    while (beat < measure.end - 1e-9) {
      const perf = beatToSeconds(score, beat);
      if (perf > hardLimit) break outer;
      beatTicks.push({ perf, accent: beatInMeasure === 0 });
      beat += 1;
      beatInMeasure += 1;
      if (beatTicks.length >= 4000) break outer;
    }
  }

  const bpm = Math.max(20, tempoAt(score, 0) || 120);
  return {
    notes,
    duration,
    bpm: Number.isFinite(bpm) ? bpm : 120,
    beatTicks,
    totalSourceNotes: sourceNotes.length,
    truncated: chosen.length < sourceNotes.length,
  };
}

// ---------------------------------------------------------------------------
// Canvas drawing
// ---------------------------------------------------------------------------

function computeGeometry(width: number, height: number, keybedHeight: number): Geometry {
  const keybedTop = Math.max(140, height - Math.max(56, keybedHeight));
  const laneW = width / LANE_COUNT;
  const topY = Math.round(Math.min(58, Math.max(24, height * 0.08)));
  const hitY = Math.round(clamp(keybedTop - 48, topY + 110, height - 60));
  return { width, height, laneW, topY, hitY, keybedTop };
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawLanes(ctx: CanvasRenderingContext2D, geo: Geometry, palette: Palette): void {
  for (let lane = 0; lane < LANE_COUNT; lane += 1) {
    const x = lane * geo.laneW;
    const black = BLACK_LANES.has(lane);
    ctx.fillStyle = black ? 'rgba(6, 9, 14, 0.6)' : 'rgba(255, 255, 255, 0.02)';
    ctx.fillRect(x, 0, geo.laneW, geo.keybedTop);
    ctx.strokeStyle = 'rgba(38, 48, 63, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, geo.keybedTop);
    ctx.stroke();
  }

  const depth = ctx.createLinearGradient(0, 0, 0, geo.hitY);
  depth.addColorStop(0, 'rgba(8, 11, 17, 0.94)');
  depth.addColorStop(0.25, 'rgba(8, 11, 17, 0.4)');
  depth.addColorStop(1, 'rgba(8, 11, 17, 0)');
  ctx.fillStyle = depth;
  ctx.fillRect(0, 0, geo.width, geo.hitY);

  // A subtle accent along the very top so the playfield has a horizon.
  ctx.fillStyle = 'rgba(224, 182, 76, 0.16)';
  ctx.fillRect(0, 0, geo.width, 1);
  ctx.fillStyle = palette.muted;
  ctx.globalAlpha = 0.35;
  ctx.fillRect(0, geo.keybedTop - 1, geo.width, 1);
  ctx.globalAlpha = 1;
}

function drawBeatGrid(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  run: Run,
  nowWall: number,
): void {
  const ticks = run.beatTicks;
  if (ticks.length === 0) return;
  const approachMs = APPROACH_SEC * 1000;
  const travel = geo.hitY - geo.topY;
  const fromPerf = runPerf(run, nowWall) - 0.2;
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid].perf < fromPerf) lo = mid + 1;
    else hi = mid;
  }
  ctx.save();
  for (let i = lo; i < ticks.length; i += 1) {
    const tick = ticks[i];
    const wall = run.musicStartWall + (tick.perf * 1000) / run.tempoScale;
    const y = geo.hitY - ((wall - nowWall) / approachMs) * travel;
    if (y < geo.topY - 2) break;
    if (y > geo.hitY + 2) continue;
    ctx.strokeStyle = tick.accent ? 'rgba(224, 182, 76, 0.18)' : 'rgba(141, 153, 173, 0.09)';
    ctx.lineWidth = tick.accent ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(geo.width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLaneFlashes(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  run: Run,
  nowWall: number,
): void {
  for (const [lane, flashWall] of run.laneFlashes) {
    if (nowWall - flashWall > 300 || nowWall < flashWall) continue;
    const t = (nowWall - flashWall) / 300;
    const x = lane * geo.laneW;
    const alpha = (1 - t) * 0.34;
    const grad = ctx.createLinearGradient(0, geo.hitY - 90, 0, geo.hitY + 6);
    grad.addColorStop(0, 'rgba(224, 182, 76, 0)');
    grad.addColorStop(1, `rgba(224, 182, 76, ${alpha.toFixed(3)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, geo.hitY - 90, geo.laneW, 96);
  }
}

function drawHitLine(ctx: CanvasRenderingContext2D, geo: Geometry, palette: Palette): void {
  const band = ctx.createLinearGradient(0, geo.hitY - 34, 0, geo.hitY + 10);
  band.addColorStop(0, 'rgba(224, 182, 76, 0)');
  band.addColorStop(0.7, 'rgba(224, 182, 76, 0.12)');
  band.addColorStop(1, 'rgba(224, 182, 76, 0.4)');
  ctx.fillStyle = band;
  ctx.fillRect(0, geo.hitY - 34, geo.width, 44);

  ctx.save();
  ctx.shadowColor = palette.accent;
  ctx.shadowBlur = 16;
  ctx.fillStyle = palette.accent;
  ctx.fillRect(0, geo.hitY - 1, geo.width, 2);
  ctx.restore();

  // Keybed separation.
  ctx.fillStyle = 'rgba(8, 11, 17, 0.9)';
  ctx.fillRect(0, geo.hitY + 12, geo.width, Math.max(0, geo.keybedTop - geo.hitY - 12));
}

function drawNotes(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  palette: Palette,
  run: Run,
  nowWall: number,
): void {
  const approachMs = APPROACH_SEC * 1000;
  const travel = geo.hitY - geo.topY;
  for (const note of run.notes) {
    if (note.state !== 'pending') continue;
    const wall = noteWall(run, note);
    const delta = wall - nowWall;
    if (delta > approachMs || delta < -1200) continue;
    const y = geo.hitY - (delta / approachMs) * travel;
    const height = clamp(
      (note.durationPerf * 1000 / run.tempoScale / approachMs) * travel,
      16,
      118,
    );
    const black = BLACK_LANES.has(note.lane);
    const inset = Math.min(6, Math.max(2, geo.laneW * 0.09));
    const x = note.lane * geo.laneW + inset;
    const width = Math.max(6, geo.laneW - inset * 2);
    const top = y - height;
    if (top > geo.keybedTop + 40 || y < geo.topY - 200) continue;

    const grad = ctx.createLinearGradient(0, top, 0, y);
    grad.addColorStop(0, black ? '#a9d4ff' : '#f7df9b');
    grad.addColorStop(1, black ? palette.accent2 : palette.accent);

    ctx.save();
    ctx.shadowColor = black ? 'rgba(99, 179, 237, 0.55)' : 'rgba(224, 182, 76, 0.5)';
    ctx.shadowBlur = 12;
    roundedRect(ctx, x, top, width, height, Math.min(7, width * 0.24));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    if (height >= 24 && width >= 30) {
      ctx.save();
      ctx.fillStyle = black ? '#08131f' : '#241b06';
      ctx.font = `700 ${Math.min(13, Math.max(9, width * 0.26))}px ${CANVAS_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.85;
      ctx.fillText(note.names[0] ?? '', x + width / 2, y - 15);
      ctx.restore();
    }
  }
}

function drawPopups(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  run: Run,
  nowWall: number,
): void {
  for (const popup of run.popups) {
    const age = nowWall - popup.wall;
    if (age < 0 || age > POPUP_LIFE_MS) continue;
    const t = age / POPUP_LIFE_MS;
    const x = popup.lane * geo.laneW + geo.laneW / 2;
    const y = geo.hitY - 30 - t * 64;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - t * t);
    ctx.fillStyle = popup.color;
    ctx.font = `800 ${popup.big ? 19 : 15}px ${CANVAS_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = popup.color;
    ctx.shadowBlur = 14;
    ctx.fillText(popup.text, x, y);
    ctx.restore();
  }
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  palette: Palette,
  run: Run | null,
  nowWall: number,
): void {
  drawLanes(ctx, geo, palette);
  if (!run) {
    drawHitLine(ctx, geo, palette);
    return;
  }
  drawBeatGrid(ctx, geo, run, nowWall);
  drawLaneFlashes(ctx, geo, run, nowWall);
  drawHitLine(ctx, geo, palette);
  drawNotes(ctx, geo, palette, run, nowWall);
  drawPopups(ctx, geo, run, nowWall);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GameView({ score, engine, onExit, onActiveKeysChange }: GameViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const keybedRef = useRef<HTMLDivElement | null>(null);
  const runRef = useRef<Run | null>(null);
  const phaseRef = useRef<GamePhase>('idle');
  const engineRef = useRef<PianoEngine>(engine);
  const callbacksRef = useRef({ onExit, onActiveKeysChange });
  const octaveRef = useRef(4);
  const optsRef = useRef<GameOptions>({ length: 'short', tempoScale: 1, guide: true, assist: false });
  const viewRef = useRef({ width: 960, height: 480, dpr: 1 });
  const paletteRef = useRef<Palette>(FALLBACK_PALETTE);
  const lastHudWallRef = useRef(0);
  const hudDirtyRef = useRef(true);
  const mountedRef = useRef(false);
  const startingRef = useRef(false);
  const goTimerRef = useRef<number | null>(null);
  const finishRef = useRef<(run: Run) => void>(() => {});

  const [phase, setPhaseState] = useState<GamePhase>('idle');
  const [options, setOptionsState] = useState<GameOptions>(optsRef.current);
  const [hud, setHud] = useState<HudState>(EMPTY_HUD);
  const [result, setResultState] = useState<GameResult | null>(null);
  const [octave, setOctaveState] = useState(4);
  const [activeLanes, setActiveLanes] = useState<number[]>([]);
  const [starting, setStarting] = useState(false);
  const [showGo, setShowGo] = useState(false);

  const prepared = useMemo(() => prepareGame(score, options.length), [score, options.length]);
  const preparedRef = useRef<PreparedGame>(prepared);
  preparedRef.current = prepared;
  const usedLanes = useMemo(
    () => new Set(prepared.notes.map((note) => note.lane)),
    [prepared],
  );

  // Keep mutable mirrors of props / callbacks current.
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);
  useEffect(() => {
    callbacksRef.current = { onExit, onActiveKeysChange };
  }, [onExit, onActiveKeysChange]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (goTimerRef.current !== null) window.clearTimeout(goTimerRef.current);
    };
  }, []);

  const pushPhase = useCallback((next: GamePhase) => {
    phaseRef.current = next;
    const run = runRef.current;
    if (run) run.phase = next;
    setPhaseState(next);
  }, []);

  const notifyActiveKeys = useCallback(() => {
    const run = runRef.current;
    const midis = run ? Array.from(new Set(Array.from(run.activeInputs.values()).map((held) => held.midi))) : [];
    try {
      callbacksRef.current.onActiveKeysChange?.(midis);
    } catch {
      // Consumer errors must not break the game loop.
    }
  }, []);

  const syncActiveLanes = useCallback(() => {
    const run = runRef.current;
    const lanes = run ? Array.from(new Set(Array.from(run.activeInputs.values()).map((held) => held.lane))) : [];
    setActiveLanes(lanes);
  }, []);

  const pushHud = useCallback((force: boolean, wall: number) => {
    const run = runRef.current;
    if (!run) return;
    if (!force && !hudDirtyRef.current && wall - lastHudWallRef.current < HUD_INTERVAL_MS) return;
    lastHudWallRef.current = wall;
    hudDirtyRef.current = false;
    const stats = run.stats;
    let countIn = 0;
    if (run.phase === 'countin') {
      const beatMs = run.countInMs / COUNT_IN_BEATS;
      const elapsed = Math.max(0, wall - run.countInStartWall);
      countIn = clamp(COUNT_IN_BEATS - Math.floor(elapsed / Math.max(1, beatMs)), 1, COUNT_IN_BEATS);
    }
    setHud({
      score: stats.score,
      combo: stats.combo,
      maxCombo: stats.maxCombo,
      accuracy: accuracyOf(stats),
      perfect: stats.counts.perfect,
      great: stats.counts.great,
      good: stats.counts.good,
      miss: stats.counts.miss,
      judged: stats.judged,
      total: run.totalNotes,
      progress: progressOf(stats.judged, run.totalNotes),
      countIn,
    });
  }, []);

  const releaseAllInputs = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    for (const held of run.activeInputs.values()) {
      safeAudio(() => engineRef.current.noteOff(held.midi));
    }
    run.activeInputs.clear();
    setActiveLanes([]);
    notifyActiveKeys();
    hudDirtyRef.current = true;
  }, [notifyActiveKeys]);

  const scheduleClick = useCallback((wallMs: number, accent: boolean) => {
    scheduleClickAt(engineRef.current, wallMs, accent);
  }, []);

  const beginRun = useCallback(() => {
    const prep = preparedRef.current;
    if (prep.notes.length === 0) return;
    const tempoScale = clamp(optsRef.current.tempoScale, 0.5, 1.25);
    const beatMs = 60000 / Math.max(30, prep.bpm) / tempoScale;
    const countInMs = Math.max(COUNT_IN_MIN_MS, beatMs * COUNT_IN_BEATS);
    const nowWall = performance.now();
    const notes: HitNote[] = prep.notes.map((note) => ({
      ...note,
      midis: [...note.midis],
      names: [...note.names],
      state: 'pending',
      judgement: undefined,
    }));
    runRef.current = {
      phase: 'countin',
      notes,
      beatTicks: prep.beatTicks,
      musicStartWall: nowWall + countInMs + NOTE_LEAD_MS,
      countInStartWall: nowWall,
      countInMs,
      tempoScale,
      stats: { ...EMPTY_SCORE_STATE, counts: { ...EMPTY_SCORE_STATE.counts } },
      judged: 0,
      totalNotes: notes.length,
      duration: prep.duration,
      missCursor: 0,
      assistCursor: 0,
      beatCursor: 0,
      guideScheduled: new Set(),
      activeInputs: new Map(),
      laneFlashes: new Map(),
      popups: [],
      pauseWall: 0,
      lastJudgedWall: nowWall,
      allJudgedWall: 0,
    };
    releaseAllInputs();
    pushPhase('countin');
    setResultState(null);
    setShowGo(false);
    hudDirtyRef.current = true;
    pushHud(true, nowWall);
    for (let beat = 0; beat < COUNT_IN_BEATS; beat += 1) {
      scheduleClick(nowWall + beat * beatMs, beat === 0);
    }
  }, [pushPhase, pushHud, releaseAllInputs, scheduleClick]);

  const startGame = useCallback(async () => {
    if (startingRef.current || preparedRef.current.notes.length === 0) return;
    startingRef.current = true;
    setStarting(true);
    try {
      await engineRef.current.ensureStarted();
    } catch {
      // Audio is optional: the game keeps working silently.
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
    }
    if (!mountedRef.current) return;
    beginRun();
  }, [beginRun]);

  const finishRun = useCallback(
    (run: Run) => {
      if (run.phase === 'results') return;
      releaseAllInputs();
      safeAudio(() => engineRef.current.stopAll());
      run.pauseWall = performance.now();
      pushPhase('results');
      setResultState(buildResult(run.stats, run.totalNotes));
      hudDirtyRef.current = true;
      pushHud(true, performance.now());
    },
    [pushHud, pushPhase, releaseAllInputs],
  );
  useEffect(() => {
    finishRef.current = finishRun;
  }, [finishRun]);

  const judgePress = useCallback((run: Run, lane: number, wall: number) => {
    run.laneFlashes.set(lane, wall);
    let best: HitNote | null = null;
    let bestOffset = 0;
    let bestAbs = Number.POSITIVE_INFINITY;
    for (const note of run.notes) {
      if (note.lane !== lane || note.state !== 'pending') continue;
      const offset = wall - noteWall(run, note);
      if (offset < -HIT_WINDOWS.good || offset > HIT_WINDOWS.lateMiss) continue;
      const abs = Math.abs(offset);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = note;
        bestOffset = offset;
      }
    }
    if (!best) return;
    const judgement = judgeTiming(bestOffset);
    if (!judgement) return;
    best.state = judgement === 'miss' ? 'missed' : 'hit';
    best.judgement = judgement;
    run.stats = applyJudgement(run.stats, judgement);
    run.judged += 1;
    run.lastJudgedWall = wall;
    const palette = paletteRef.current;
    run.popups.push({
      text: JUDGEMENT_LABEL[judgement],
      color: palette[judgement],
      lane,
      wall,
      big: judgement === 'perfect',
    });
    if (run.judged >= run.totalNotes) run.allJudgedWall = wall;
    hudDirtyRef.current = true;
  }, []);

  const pressInput = useCallback(
    (source: string, lane: number, midi: number) => {
      const run = runRef.current;
      if (!run || run.phase !== 'playing') return;
      if (run.activeInputs.has(source)) return;
      const safeMidi = clampMidi(midi);
      run.activeInputs.set(source, { lane, midi: safeMidi });
      safeAudio(() => engineRef.current.noteOn(safeMidi, 92));
      syncActiveLanes();
      notifyActiveKeys();
      judgePress(run, lane, performance.now());
      hudDirtyRef.current = true;
    },
    [judgePress, notifyActiveKeys, syncActiveLanes],
  );

  const releaseInput = useCallback(
    (source: string) => {
      const run = runRef.current;
      if (!run) return;
      const held = run.activeInputs.get(source);
      if (!held) return;
      run.activeInputs.delete(source);
      safeAudio(() => engineRef.current.noteOff(held.midi));
      syncActiveLanes();
      notifyActiveKeys();
    },
    [notifyActiveKeys, syncActiveLanes],
  );

  const pickLaneMidi = useCallback((lane: number): number => {
    const run = runRef.current;
    const wall = performance.now();
    let best: HitNote | null = null;
    let bestAbs = Number.POSITIVE_INFINITY;
    if (run) {
      for (const note of run.notes) {
        if (note.lane !== lane || note.state !== 'pending') continue;
        const abs = Math.abs(noteWall(run, note) - wall);
        if (abs < bestAbs) {
          bestAbs = abs;
          best = note;
        }
      }
    }
    const fallback = octaveBaseMidi(octaveRef.current) + lane;
    return clampMidi(best ? best.midis[0] : fallback);
  }, []);

  const shiftOctave = useCallback((direction: 1 | -1) => {
    const next = clamp(octaveRef.current + direction, MIN_OCTAVE, MAX_OCTAVE);
    if (next === octaveRef.current) return;
    octaveRef.current = next;
    setOctaveState(next);
  }, []);

  const pauseGame = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    if (run.phase !== 'playing' && run.phase !== 'countin') return;
    run.pauseWall = performance.now();
    releaseAllInputs();
    safeAudio(() => engineRef.current.stopAll());
    run.guideScheduled.clear();
    pushPhase('paused');
    hudDirtyRef.current = true;
    pushHud(true, run.pauseWall);
  }, [pushHud, pushPhase, releaseAllInputs]);

  const resumeGame = useCallback(() => {
    const run = runRef.current;
    if (!run || run.phase !== 'paused') return;
    const now = performance.now();
    const countInEndWall = run.countInStartWall + run.countInMs;
    if (run.pauseWall < countInEndWall) {
      // Paused during the count-in: restart the count-in from the top.
      run.countInStartWall = now;
      run.musicStartWall = now + run.countInMs + NOTE_LEAD_MS;
      const beatMs = run.countInMs / COUNT_IN_BEATS;
      for (let beat = 0; beat < COUNT_IN_BEATS; beat += 1) {
        scheduleClick(now + beat * beatMs, beat === 0);
      }
      run.pauseWall = 0;
      pushPhase('countin');
    } else {
      const perf = Math.max(0, runPerf(run, run.pauseWall));
      run.musicStartWall = now + RESUME_LEAD_MS - (perf * 1000) / run.tempoScale;
      run.beatCursor = 0;
      run.assistCursor = 0;
      run.guideScheduled.clear();
      run.pauseWall = 0;
      pushPhase('playing');
    }
    hudDirtyRef.current = true;
    pushHud(true, now);
  }, [pushHud, pushPhase, scheduleClick]);

  const togglePause = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    if (run.phase === 'paused') resumeGame();
    else if (run.phase === 'playing' || run.phase === 'countin') pauseGame();
  }, [pauseGame, resumeGame]);

  const changeTempo = useCallback(
    (value: number) => {
      const next = clamp(Math.round(value * 100) / 100, 0.5, 1.25);
      const run = runRef.current;
      if (run && run.phase !== 'idle' && run.phase !== 'results') {
        const refWall = run.phase === 'paused' ? run.pauseWall : performance.now();
        const perf = Math.max(0, runPerf(run, refWall));
        run.tempoScale = next;
        run.musicStartWall = refWall - (perf * 1000) / next;
        run.beatCursor = 0;
        run.assistCursor = 0;
        run.guideScheduled.clear();
        if (run.phase === 'playing') safeAudio(() => engineRef.current.stopAll());
      }
      optsRef.current = { ...optsRef.current, tempoScale: next };
      setOptionsState(optsRef.current);
      hudDirtyRef.current = true;
    },
    [],
  );

  const setLength = useCallback((length: LengthMode) => {
    optsRef.current = { ...optsRef.current, length };
    setOptionsState(optsRef.current);
  }, []);

  const toggleOption = useCallback((key: 'guide' | 'assist') => {
    optsRef.current = { ...optsRef.current, [key]: !optsRef.current[key] };
    setOptionsState(optsRef.current);
  }, []);

  const backToSetup = useCallback(() => {
    releaseAllInputs();
    safeAudio(() => engineRef.current.stopAll());
    runRef.current = null;
    setResultState(null);
    setShowGo(false);
    pushPhase('idle');
    setHud(EMPTY_HUD);
    setActiveLanes([]);
    notifyActiveKeys();
  }, [notifyActiveKeys, pushPhase, releaseAllInputs]);

  const retryGame = useCallback(() => {
    void startGame();
  }, [startGame]);

  const exitGame = useCallback(() => {
    releaseAllInputs();
    safeAudio(() => engineRef.current.stopAll());
    runRef.current = null;
    pushPhase('idle');
    notifyActiveKeys();
    try {
      callbacksRef.current.onExit();
    } catch {
      // Ignore consumer navigation errors.
    }
  }, [notifyActiveKeys, pushPhase, releaseAllInputs]);

  // ------------------------------------------------------------------ input

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();

      if (key === 'escape') {
        event.preventDefault();
        togglePause();
        return;
      }
      if (key === 'z' || key === 'x') {
        event.preventDefault();
        shiftOctave(key === 'z' ? -1 : 1);
        return;
      }
      const semitone = QWERTY_KEYMAP[key];
      if (semitone === undefined) return;
      const run = runRef.current;
      if (!run || run.phase !== 'playing') return;
      const midi = octaveBaseMidi(octaveRef.current) + semitone;
      if (midi < 21 || midi > 108) return;
      event.preventDefault();
      pressInput(`key:${key}`, laneOfMidi(midi), midi);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (QWERTY_KEYMAP[key] === undefined) return;
      releaseInput(`key:${key}`);
    };

    const onBlur = () => releaseAllInputs();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') pauseGame();
    };
    const onPointerUp = () => {
      const run = runRef.current;
      if (!run) return;
      let changed = false;
      for (const source of Array.from(run.activeInputs.keys())) {
        if (source.startsWith('pointer:') || source.startsWith('lane:')) {
          releaseInput(source);
          changed = true;
        }
      }
      if (changed) hudDirtyRef.current = true;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      document.removeEventListener('visibilitychange', onVisibility);
      releaseAllInputs();
    };
  }, [pauseGame, pressInput, releaseAllInputs, releaseInput, shiftOctave, togglePause]);

  // ------------------------------------------------------------ game loop

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paletteRef.current = readPalette();

    const resize = () => {
      const width = Math.max(320, Math.round(stage.clientWidth));
      const height = Math.max(240, Math.round(stage.clientHeight));
      const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
      viewRef.current = { width, height, dpr };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resize();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => resize());
      observer.observe(stage);
    }

    const livePalette = () => paletteRef.current ?? FALLBACK_PALETTE;

    const registerMiss = (run: Run, note: HitNote, wall: number) => {
      note.state = 'missed';
      note.judgement = 'miss';
      run.stats = applyJudgement(run.stats, 'miss');
      run.judged += 1;
      run.lastJudgedWall = wall;
      run.laneFlashes.set(note.lane, wall);
      run.popups.push({
        text: JUDGEMENT_LABEL.miss,
        color: livePalette().miss,
        lane: note.lane,
        wall,
        big: false,
      });
      if (run.judged >= run.totalNotes) run.allJudgedWall = wall;
      hudDirtyRef.current = true;
    };

    const advanceMisses = (run: Run, wall: number) => {
      while (run.missCursor < run.notes.length) {
        const note = run.notes[run.missCursor];
        if (note.state !== 'pending') {
          run.missCursor += 1;
          continue;
        }
        const offset = wall - noteWall(run, note);
        if (offset <= HIT_WINDOWS.lateMiss) break;
        registerMiss(run, note, wall);
        run.missCursor += 1;
      }
    };

    const scheduleGuide = (run: Run, wall: number) => {
      while (run.beatCursor < run.beatTicks.length) {
        const tick = run.beatTicks[run.beatCursor];
        const tickWall = run.musicStartWall + (tick.perf * 1000) / run.tempoScale;
        if (tickWall > wall + GUIDE_LOOKAHEAD_MS) break;
        run.beatCursor += 1;
        if (!optsRef.current.guide) continue;
        if (tickWall < wall - 220) continue;
        scheduleClick(tickWall, tick.accent);
      }
    };

    const scheduleAssist = (run: Run, wall: number) => {
      const assist = optsRef.current.assist;
      while (run.assistCursor < run.notes.length) {
        const note = run.notes[run.assistCursor];
        const wallStart = noteWall(run, note);
        if (wallStart > wall + ASSIST_LOOKAHEAD_MS) break;
        run.assistCursor += 1;
        if (!assist || note.state !== 'pending' || run.guideScheduled.has(note.id)) continue;
        if (wallStart < wall - 500) continue;
        run.guideScheduled.add(note.id);
        const engineInstance = engineRef.current;
        const delay = Math.max(0.02, (wallStart - performance.now()) / 1000);
        const duration = Math.max(0.2, Math.min(1.1, note.durationPerf / run.tempoScale));
        for (const midi of note.midis) {
          safeAudio(() => engineInstance.scheduleNote(midi, 34, engineInstance.now() + delay, duration));
        }
      }
    };

    const frame = (wall: number) => {
      const run = runRef.current;

      if (run) {
        if (
          run.phase === 'countin' &&
          wall >= run.countInStartWall + run.countInMs
        ) {
          // The count-in is over; the first note still has NOTE_LEAD_MS to fall.
          run.phase = 'playing';
          phaseRef.current = 'playing';
          setPhaseState('playing');
          setShowGo(true);
          hudDirtyRef.current = true;
          if (goTimerRef.current !== null) window.clearTimeout(goTimerRef.current);
          goTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current) setShowGo(false);
          }, 750);
        }
        if (run.phase === 'playing') {
          advanceMisses(run, wall);
          scheduleGuide(run, wall);
          scheduleAssist(run, wall);
          if (run.judged >= run.totalNotes && run.totalNotes > 0) {
            if (run.allJudgedWall === 0) run.allJudgedWall = wall;
            if (wall - run.allJudgedWall > 600) finishRef.current(run);
          }
          // Retire stale flashes / popups so the maps cannot grow forever.
          for (const [lane, flashWall] of run.laneFlashes) {
            if (wall - flashWall > 800) run.laneFlashes.delete(lane);
          }
          run.popups = run.popups.filter((popup) => wall - popup.wall <= POPUP_LIFE_MS);
        }
        if (run.phase === 'playing' || run.phase === 'countin') pushHud(false, wall);
      }

      const view = viewRef.current;
      const keybedHeight = keybedRef.current?.offsetHeight ?? KEYBED_FALLBACK_H;
      const geometry = computeGeometry(view.width, view.height, keybedHeight);
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.clearRect(0, 0, view.width, view.height);
      const runNow = runRef.current;
      let drawNow = wall;
      if (runNow && (runNow.phase === 'paused' || runNow.phase === 'results')) {
        drawNow = runNow.pauseWall || wall;
      }
      drawScene(ctx, geometry, livePalette(), runNow, drawNow);
      rafId = requestAnimationFrame(frame);
    };

    let rafId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(rafId);
      observer?.disconnect();
    };
  }, [pushHud, scheduleClick]);

  // Unmount cleanup: never leak held notes or the engine.
  useEffect(() => {
    return () => {
      const run = runRef.current;
      if (run) {
        for (const held of run.activeInputs.values()) {
          safeAudio(() => engine.noteOff(held.midi));
        }
        run.activeInputs.clear();
        runRef.current = null;
      }
      safeAudio(() => engine.stopAll());
      try {
        callbacksRef.current.onActiveKeysChange?.([]);
      } catch {
        // ignore
      }
    };
  }, [engine]);

  // ---------------------------------------------------------------- render

  const hasNotes = prepared.notes.length > 0;
  const laneKeyHint = (lane: number) => qwertyLabelForMidi(octaveBaseMidi(octave) + lane, octave);
  const tempoLabel = `${options.tempoScale.toFixed(2)}×`;
  const countInNumber = hud.countIn > 0 ? hud.countIn : COUNT_IN_BEATS;

  const lengthControl = (
    <div className="game-option">
      <div className="game-option-label">
        <strong>Length</strong>
        <small>Keep it short for a quick warm-up, or play the whole piece.</small>
      </div>
      <div className="game-seg" role="group" aria-label="Segment length">
        <button
          type="button"
          className={options.length === 'short' ? 'on' : ''}
          onClick={() => setLength('short')}
        >
          Short
        </button>
        <button
          type="button"
          className={options.length === 'full' ? 'on' : ''}
          onClick={() => setLength('full')}
        >
          Full
        </button>
      </div>
    </div>
  );

  const tempoControl = (
    <div className="game-option">
      <div className="game-option-label">
        <strong>Tempo</strong>
        <small>Slow the music down while you learn the notes.</small>
      </div>
      <div className="game-slider">
        <input
          type="range"
          min={0.5}
          max={1.25}
          step={0.05}
          value={options.tempoScale}
          onChange={(event) => changeTempo(Number(event.target.value))}
          aria-label="Tempo scale"
        />
        <output>{tempoLabel}</output>
      </div>
    </div>
  );

  const toggleGuide = (
    <div className="game-option">
      <div className="game-option-label">
        <strong>Guide metronome</strong>
        <small>A click on every beat, accented on the downbeat.</small>
      </div>
      <button
        type="button"
        className={`game-toggle ${options.guide ? 'on' : ''}`}
        aria-pressed={options.guide}
        onClick={() => toggleOption('guide')}
      >
        <span className="dot" />
        {options.guide ? 'On' : 'Off'}
      </button>
    </div>
  );

  const toggleAssist = (
    <div className="game-option">
      <div className="game-option-label">
        <strong>Assist</strong>
        <small>Quietly plays the target notes so you can hear the tune.</small>
      </div>
      <button
        type="button"
        className={`game-toggle ${options.assist ? 'on' : ''}`}
        aria-pressed={options.assist}
        onClick={() => toggleOption('assist')}
      >
        <span className="dot" />
        {options.assist ? 'On' : 'Off'}
      </button>
    </div>
  );

  return (
    <div className="game-view" data-phase={phase}>
      <div className="game-topbar">
        <div className="game-topbar-main">
          <h2 className="game-title">Falling Notes</h2>
          <p className="game-subtitle">
            {score.title || 'Untitled score'}
            {score.composer ? ` · ${score.composer}` : ''} · {prepared.notes.length} notes ·{' '}
            {formatDuration(prepared.duration)}
          </p>
        </div>
        <div className="game-topbar-actions">
          <span className="game-chip accent">
            Tempo <strong>{tempoLabel}</strong>
          </span>
          <span className="game-chip">Octave <strong>{octave}</strong></span>
          {options.guide ? <span className="game-chip">Guide</span> : null}
          {options.assist ? <span className="game-chip blue">Assist</span> : null}
          {phase === 'playing' || phase === 'countin' ? (
            <button type="button" onClick={pauseGame}>
              Pause
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={exitGame}>
            Back to library
          </button>
        </div>
      </div>

      <div className="game-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="game-canvas"
          aria-label="Falling notes playfield"
          onPointerDown={(event) => {
            if (phaseRef.current !== 'playing') return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width <= 0) return;
            const lane = clamp(
              Math.floor(((event.clientX - rect.left) / rect.width) * LANE_COUNT),
              0,
              LANE_COUNT - 1,
            );
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // Pointer capture is a nicety, not a requirement.
            }
            pressInput(`pointer:${event.pointerId}`, lane, pickLaneMidi(lane));
          }}
          onPointerUp={(event) => releaseInput(`pointer:${event.pointerId}`)}
          onPointerCancel={(event) => releaseInput(`pointer:${event.pointerId}`)}
        />

        <div className="game-hud">
          <div className="game-hud-top">
            <div className="hud-block">
              <div className="hud-stat">
                <span>Score</span>
                <strong>{hud.score.toLocaleString('en-US')}</strong>
              </div>
              <div className="hud-stat">
                <span>Combo</span>
                <strong className={hud.combo >= 10 ? 'hot' : ''}>
                  {hud.combo}
                  <em>
                    ×{comboMultiplier(hud.combo).toFixed(2)}
                  </em>
                </strong>
              </div>
              <div className="hud-stat">
                <span>Accuracy</span>
                <strong>{hud.accuracy.toFixed(1)}%</strong>
              </div>
            </div>
            <div className="hud-block">
              <div className="hud-counts">
                <div className="hud-count perfect">
                  <span>Perfect</span>
                  <strong>{hud.perfect}</strong>
                </div>
                <div className="hud-count great">
                  <span>Great</span>
                  <strong>{hud.great}</strong>
                </div>
                <div className="hud-count good">
                  <span>Good</span>
                  <strong>{hud.good}</strong>
                </div>
                <div className="hud-count miss">
                  <span>Miss</span>
                  <strong>{hud.miss}</strong>
                </div>
              </div>
            </div>
          </div>

          {phase === 'playing' && hud.combo >= 5 ? (
            <div className="game-combo" key={hud.combo}>
              {hud.combo}
              <small>combo</small>
            </div>
          ) : null}

          <div className="game-progress">
            <span>Progress</span>
            <div className="game-progress-track">
              <div
                className="game-progress-fill"
                style={{ width: `${(hud.progress * 100).toFixed(1)}%` }}
              />
            </div>
            <span>
              {hud.judged}/{hud.total}
            </span>
          </div>
        </div>

        <div className="game-keybed" ref={keybedRef}>
          {PITCH_NAMES.map((name, lane) => {
            const black = BLACK_LANES.has(lane);
            const hint = laneKeyHint(lane);
            const active = activeLanes.includes(lane);
            return (
              <button
                key={name}
                type="button"
                className={`game-key ${black ? 'dark' : 'white'} ${
                  usedLanes.has(lane) ? '' : 'unused'
                } ${active ? 'active' : ''}`}
                aria-label={`Play ${name}, keyboard ${hint || 'unmapped'}`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // ignore
                  }
                  pressInput(`lane:${lane}:${event.pointerId}`, lane, pickLaneMidi(lane));
                }}
                onPointerUp={(event) => releaseInput(`lane:${lane}:${event.pointerId}`)}
                onPointerCancel={(event) => releaseInput(`lane:${lane}:${event.pointerId}`)}
                onLostPointerCapture={(event) => releaseInput(`lane:${lane}:${event.pointerId}`)}
              >
                <span className="key-note">{name}</span>
                <span className="key-letter">{hint || '·'}</span>
              </button>
            );
          })}
        </div>

        {phase === 'idle' ? (
          <div className="game-overlay">
            <div className="game-dialog">
              <p className="game-eyebrow">Falling notes · practice</p>
              <h3>{score.title || 'Untitled score'}</h3>
              {!hasNotes ? (
                <div className="game-empty">
                  <p className="game-dialog-lede">
                    This score has no playable notes yet. Import a MIDI or MusicXML file, then
                    come back to practice it.
                  </p>
                  <div className="game-actions">
                    <button type="button" onClick={exitGame}>
                      Back to library
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="game-dialog-lede">
                    Notes fall towards the hit line — press the matching key as they cross it.
                    Match by note name; <kbd>Z</kbd>/<kbd>X</kbd> shifts the octave of the note
                    you produce.
                  </p>
                  <div className="game-meta">
                    <span>{prepared.notes.length} notes</span>
                    <span>{formatDuration(prepared.duration)}</span>
                    <span>{Math.round(prepared.bpm)} BPM</span>
                    <span>{prepared.truncated ? 'first segment' : 'whole score'}</span>
                  </div>
                  {lengthControl}
                  {tempoControl}
                  {toggleGuide}
                  {toggleAssist}
                  <div className="game-actions">
                    <button
                      type="button"
                      className="primary"
                      data-autostart="start"
                      onClick={() => void startGame()}
                      disabled={starting}
                    >
                      {starting ? 'Starting…' : 'Start practice'}
                    </button>
                    <button type="button" className="ghost" onClick={exitGame}>
                      Back to library
                    </button>
                  </div>
                  <p className="game-hint">
                    <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> <kbd>F</kbd> <kbd>G</kbd>{' '}
                    <kbd>H</kbd> <kbd>J</kbd> <kbd>K</kbd> white notes ·{' '}
                    <kbd>W</kbd> <kbd>E</kbd> <kbd>T</kbd> <kbd>Y</kbd> <kbd>U</kbd> black notes
                    · <kbd>Z</kbd>/<kbd>X</kbd> octave · <kbd>Esc</kbd> pause
                  </p>
                </>
              )}
            </div>
          </div>
        ) : null}

        {phase === 'countin' ? (
          <div className="game-overlay countin">
            <div className="game-countin">
              <div className="game-countin-number" key={hud.countIn}>
                {countInNumber}
              </div>
              <div className="game-countin-label">Get ready</div>
            </div>
          </div>
        ) : null}

        {showGo && phase === 'playing' ? <div className="game-go">GO</div> : null}

        {phase === 'paused' ? (
          <div className="game-overlay">
            <div className="game-dialog">
              <p className="game-eyebrow">Paused</p>
              <h3>Take a breath</h3>
              <p className="game-dialog-lede">
                Resume with a short lead-in. Changing tempo restarts the run at the same position.
              </p>
              <div className="game-meta">
                <span>Score {hud.score.toLocaleString('en-US')}</span>
                <span>Combo {hud.combo}</span>
                <span>Accuracy {hud.accuracy.toFixed(1)}%</span>
                <span>
                  {hud.judged}/{hud.total} notes
                </span>
              </div>
              {tempoControl}
              {toggleGuide}
              {toggleAssist}
              <div className="game-actions">
                <button type="button" className="primary" onClick={resumeGame}>
                  Resume
                </button>
                <button type="button" onClick={retryGame}>
                  Restart
                </button>
                <span className="spacer" />
                <button type="button" className="ghost" onClick={exitGame}>
                  Quit
                </button>
              </div>
              <p className="game-hint">
                <kbd>Esc</kbd> resume · <kbd>Z</kbd>/<kbd>X</kbd> octave
              </p>
            </div>
          </div>
        ) : null}

        {phase === 'results' && result ? (
          <div className="game-overlay">
            <div className="game-dialog">
              <div className="game-results">
                <div className="game-results-head">
                  <div className={`game-rank rank-${result.rank}`} aria-hidden="true">
                    {result.rank}
                  </div>
                  <div className="game-results-title">
                    <p className="game-eyebrow">
                      {result.rank === 'S'
                        ? 'Flawless run'
                        : result.rank === 'A'
                          ? 'Great run'
                          : result.rank === 'B'
                            ? 'Solid practice'
                            : result.rank === 'C'
                              ? 'Keep going'
                              : 'Warm-up complete'}
                    </p>
                    <div className="game-results-score">
                      {result.score.toLocaleString('en-US')}
                      <small>points</small>
                    </div>
                    <p className="game-dialog-lede">
                      {result.accuracy.toFixed(1)}% accuracy · max combo {result.maxCombo} ·{' '}
                      {result.judged}/{result.totalNotes} notes judged
                    </p>
                  </div>
                </div>
                <div className="game-result-grid">
                  <div className="game-result-stat perfect">
                    <span>Perfect</span>
                    <strong>{result.counts.perfect}</strong>
                  </div>
                  <div className="game-result-stat great">
                    <span>Great</span>
                    <strong>{result.counts.great}</strong>
                  </div>
                  <div className="game-result-stat good">
                    <span>Good</span>
                    <strong>{result.counts.good}</strong>
                  </div>
                  <div className="game-result-stat miss">
                    <span>Miss</span>
                    <strong>{result.counts.miss}</strong>
                  </div>
                  <div className="game-result-stat">
                    <span>Max combo</span>
                    <strong>{result.maxCombo}</strong>
                  </div>
                  <div className="game-result-stat">
                    <span>Accuracy</span>
                    <strong>{result.accuracy.toFixed(1)}%</strong>
                  </div>
                </div>
                <div className="game-actions">
                  <button
                    type="button"
                    className="primary"
                    data-autostart="retry"
                    onClick={retryGame}
                  >
                    Retry
                  </button>
                  <button type="button" onClick={backToSetup}>
                    Change settings
                  </button>
                  <span className="spacer" />
                  <button type="button" className="ghost" onClick={exitGame}>
                    Back to library
                  </button>
                </div>
                <p className="game-hint">
                  Tip: lower the tempo and turn on Assist to learn the melody, then push it back
                  up.
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
