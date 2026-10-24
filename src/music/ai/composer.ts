/**
 * Piano Studio AI Composer.
 *
 * A small, local generative composer: it turns a style/mood/key/length request
 * into a two-hand piano score with a chord progression, an accompaniment
 * pattern and a motif-based melody. Everything is deterministic for a given
 * seed, runs offline in the browser, and produces the same `Score` model used
 * by the rest of the app (so generated pieces can be played, viewed, recorded
 * over and exported).
 */
import type { KeySignature, NoteEvent, Score } from '../types';
import { createScore } from '../score';
import { keySignatureName } from '../pitch';

export type AiStyle = 'classical' | 'romantic' | 'pop' | 'ambient' | 'jazz' | 'waltz';
export type AiMood = 'happy' | 'calm' | 'melancholic' | 'epic' | 'dreamy';
export type AiDifficulty = 'easy' | 'medium' | 'advanced';
export type AiTimeSignature = '4/4' | '3/4' | '6/8';

export interface AiComposeOptions {
  style?: AiStyle;
  mood?: AiMood;
  /** Pitch class of the tonic, C = 0. */
  keyRoot?: number;
  mode?: 'major' | 'minor';
  bars?: number;
  bpm?: number;
  timeSignature?: AiTimeSignature;
  difficulty?: AiDifficulty;
  seed?: number;
}

export interface AiCompositionMeta {
  title: string;
  description: string;
  style: AiStyle;
  mood: AiMood;
  keyName: string;
  bars: number;
  bpm: number;
  timeSignature: AiTimeSignature;
  difficulty: AiDifficulty;
  seed: number;
}

export interface AiComposition {
  score: Score;
  meta: AiCompositionMeta;
}

export const AI_STYLES: ReadonlyArray<{ value: AiStyle; label: string }> = [
  { value: 'classical', label: 'Classical' },
  { value: 'romantic', label: 'Romantic' },
  { value: 'pop', label: 'Pop ballad' },
  { value: 'ambient', label: 'Ambient' },
  { value: 'jazz', label: 'Jazz' },
  { value: 'waltz', label: 'Waltz' },
];

export const AI_MOODS: ReadonlyArray<{ value: AiMood; label: string }> = [
  { value: 'happy', label: 'Happy' },
  { value: 'calm', label: 'Calm' },
  { value: 'melancholic', label: 'Melancholic' },
  { value: 'epic', label: 'Epic' },
  { value: 'dreamy', label: 'Dreamy' },
];

export const AI_DIFFICULTIES: ReadonlyArray<{ value: AiDifficulty; label: string }> = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'advanced', label: 'Advanced' },
];

export const AI_TIME_SIGNATURES: ReadonlyArray<{ value: AiTimeSignature; label: string }> = [
  { value: '4/4', label: '4/4' },
  { value: '3/4', label: '3/4' },
  { value: '6/8', label: '6/8' },
];

export const AI_KEY_ROOTS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'C' },
  { value: 1, label: 'C#' },
  { value: 2, label: 'D' },
  { value: 3, label: 'Eb' },
  { value: 4, label: 'E' },
  { value: 5, label: 'F' },
  { value: 6, label: 'F#' },
  { value: 7, label: 'G' },
  { value: 8, label: 'Ab' },
  { value: 9, label: 'A' },
  { value: 10, label: 'Bb' },
  { value: 11, label: 'B' },
];

/** Display name for a key (e.g. "A minor", "Eb major"). */
export function aiKeyName(keyRoot: number, mode: 'major' | 'minor'): string {
  return keyFor(((keyRoot % 12) + 12) % 12, mode).name;
}

export const AI_EXAMPLE_PROMPTS: readonly string[] = [
  'dreamy waltz in A minor, 16 bars, slow',
  'happy pop piece in C major, 100 bpm',
  'epic cinematic in D minor, 24 bars',
  'calm ambient in F major, 8 bars',
  'jazz nocturne in G minor, medium difficulty',
];

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
const MAJOR_FIFTHS_BY_PC = [0, 7, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
const MAJOR_QUALITIES = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'] as const;
const MINOR_QUALITIES = ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'] as const;

type Quality = 'maj' | 'min' | 'dim';

const STYLE_DEFAULTS: Record<AiStyle, { tempo: number; time: AiTimeSignature }> = {
  classical: { tempo: 96, time: '4/4' },
  romantic: { tempo: 74, time: '4/4' },
  pop: { tempo: 104, time: '4/4' },
  ambient: { tempo: 64, time: '4/4' },
  jazz: { tempo: 112, time: '4/4' },
  waltz: { tempo: 108, time: '3/4' },
};

const MOOD_TEMPO: Record<AiMood, number> = {
  happy: 8,
  calm: -8,
  melancholic: -6,
  epic: 4,
  dreamy: -10,
};

const DIFFICULTY_TEMPO: Record<AiDifficulty, number> = {
  easy: -8,
  medium: 0,
  advanced: 6,
};

/** Scale-degree progressions (0 = tonic) per style and mode. */
const PROGRESSIONS: Record<AiStyle, { major: number[][]; minor: number[][] }> = {
  classical: {
    major: [
      [0, 4, 5, 3],
      [0, 5, 3, 4],
      [0, 3, 0, 4],
    ],
    minor: [
      [0, 5, 2, 6],
      [0, 3, 5, 4],
      [0, 6, 5, 4],
    ],
  },
  romantic: {
    major: [
      [0, 5, 1, 4],
      [0, 5, 3, 4],
      [0, 3, 4, 0],
    ],
    minor: [
      [0, 5, 2, 6],
      [0, 3, 5, 4],
    ],
  },
  pop: {
    major: [
      [0, 4, 5, 3],
      [5, 3, 0, 4],
      [0, 5, 3, 4],
    ],
    minor: [
      [0, 5, 2, 6],
      [0, 6, 5, 4],
    ],
  },
  ambient: {
    major: [
      [0, 3, 5, 4],
      [0, 5, 3, 4],
    ],
    minor: [
      [0, 5, 2, 3],
      [0, 3, 5, 4],
    ],
  },
  jazz: {
    major: [
      [1, 4, 0, 5],
      [0, 5, 1, 4],
    ],
    minor: [
      [1, 4, 0, 5],
      [0, 3, 5, 4],
    ],
  },
  waltz: {
    major: [
      [0, 3, 0, 4],
      [0, 3, 4, 0],
    ],
    minor: [
      [0, 3, 4, 0],
      [0, 5, 3, 4],
    ],
  },
};

const TITLE_BANK: Record<AiMood, string[]> = {
  happy: ['Sunlit Steps', 'Morning Breeze', 'Golden Hour', 'May Dance', 'Little Celebration'],
  calm: ['Still Waters', 'Quiet Page', 'Soft Rain', 'Evening Light', 'Slow River'],
  melancholic: ['Faded Letter', 'Autumn Window', 'Late Train', 'Grey Sky', 'Empty Room'],
  epic: ['Rising Tide', 'Crimson Sky', 'Distant Thunder', 'Summit', 'North Star'],
  dreamy: ['Moonlit Drift', 'Cloud Garden', 'Sleepwalk', 'Paper Moon', 'Starlight'],
};

interface Chord {
  degree: number;
  rootPc: number;
  quality: Quality;
  /** Semitone intervals above the root, including a 7th when colour is enabled. */
  intervals: number[];
  bassMidi: number;
}

interface FormSection {
  kind: 'intro' | 'A' | 'B' | 'A2' | 'coda';
  startBar: number;
  bars: number;
}

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length) % items.length];
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function beatsPerBarFor(signature: AiTimeSignature): number {
  return signature === '3/4' ? 3 : signature === '6/8' ? 3 : 4;
}

function keyFor(keyRoot: number, mode: 'major' | 'minor'): KeySignature & { name: string } {
  const fifths =
    mode === 'minor'
      ? MAJOR_FIFTHS_BY_PC[(keyRoot + 3) % 12]
      : MAJOR_FIFTHS_BY_PC[keyRoot];
  return { fifths, mode, name: keySignatureName(fifths, mode) };
}

function bassMidiFor(rootPc: number): number {
  return 36 + ((rootPc % 12) + 12) % 12;
}

function makeChord(
  degree: number,
  keyRoot: number,
  mode: 'major' | 'minor',
  style: AiStyle,
  difficulty: AiDifficulty,
): Chord {
  const scale = mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  const qualities = mode === 'major' ? MAJOR_QUALITIES : MINOR_QUALITIES;
  let quality: Quality = qualities[degree] ?? 'maj';
  // Harmonic-minor dominant in classical / romantic / waltz writing.
  if (mode === 'minor' && degree === 4 && ['classical', 'romantic', 'waltz'].includes(style)) {
    quality = 'maj';
  }
  const rootPc = (keyRoot + scale[degree]) % 12;
  const intervals = quality === 'maj' ? [0, 4, 7] : quality === 'min' ? [0, 3, 7] : [0, 3, 6];

  const colour =
    difficulty !== 'easy' &&
    (style === 'jazz' ||
      style === 'romantic' ||
      style === 'ambient' ||
      (difficulty === 'advanced' && style !== 'pop'));
  if (colour) {
    intervals.push(quality === 'maj' ? 11 : 10);
  }
  return { degree, rootPc, quality, intervals, bassMidi: bassMidiFor(rootPc) };
}

function makeNote(
  id: string,
  midi: number,
  start: number,
  duration: number,
  velocity: number,
  hand: 'left' | 'right',
): NoteEvent {
  return {
    id,
    midi: clamp(Math.round(midi), 21, 108),
    start: Math.max(0, start),
    duration: Math.max(0.125, duration),
    velocity: clamp(Math.round(velocity), 1, 127),
    hand,
    track: hand === 'left' ? 1 : 0,
  };
}

/* --------------------------------------------------------------------- form */

function buildForm(bars: number): FormSection[] {
  if (bars <= 8) return [{ kind: 'A', startBar: 0, bars }];
  if (bars <= 16) {
    return [
      { kind: 'A', startBar: 0, bars: 8 },
      { kind: 'B', startBar: 8, bars: bars - 8 },
    ];
  }
  if (bars <= 24) {
    return [
      { kind: 'A', startBar: 0, bars: 8 },
      { kind: 'B', startBar: 8, bars: 8 },
      { kind: 'A2', startBar: 16, bars: bars - 16 },
    ];
  }
  const extra = bars - 24;
  const intro = Math.min(2, Math.max(0, extra));
  const coda = Math.max(2, extra - intro);
  return [
    { kind: 'intro', startBar: 0, bars: intro },
    { kind: 'A', startBar: intro, bars: 8 },
    { kind: 'B', startBar: intro + 8, bars: 8 },
    { kind: 'A2', startBar: intro + 16, bars: 8 },
    { kind: 'coda', startBar: intro + 24, bars: coda },
  ];
}

/* ------------------------------------------------------------- left hand */

function leftHandBar(
  notes: NoteEvent[],
  chord: Chord,
  nextChord: Chord | undefined,
  barStart: number,
  beatsPerBar: number,
  style: AiStyle,
  difficulty: AiDifficulty,
  rng: Rng,
  signature: AiTimeSignature,
  seed: number,
): void {
  let counter = notes.length;
  const add = (midi: number, offset: number, duration: number, velocity: number): void => {
    notes.push(
      makeNote(`ai-${seed}-${counter++}`, midi, barStart + offset, duration, velocity, 'left'),
    );
  };
  const bass = chord.bassMidi;
  const third = bass + (chord.intervals[1] ?? 4);
  const fifth = bass + (chord.intervals[2] ?? 7);
  const seventh = chord.intervals[3] ? bass + chord.intervals[3] : null;
  const upper = [third, fifth, ...(seventh ? [seventh] : [])];
  const soft = style === 'ambient';
  const baseVelocity = soft ? 46 : difficulty === 'advanced' ? 62 : 56;

  if (style === 'ambient' || difficulty === 'easy' || (signature === '6/8' && style !== 'waltz')) {
    add(bass, 0, beatsPerBar, baseVelocity - 6);
    for (const note of upper) add(note, 0, beatsPerBar, baseVelocity - 4);
    if (style === 'ambient' && beatsPerBar >= 3) {
      add(bass + 12, beatsPerBar * 0.66, beatsPerBar * 0.34, baseVelocity - 12);
    }
    return;
  }

  if (signature === '3/4') {
    add(bass, 0, 1, baseVelocity);
    add(third, 1, 1, baseVelocity - 6);
    add(fifth, 1, 1, baseVelocity - 6);
    add(third, 2, 1, baseVelocity - 8);
    add(fifth, 2, 1, baseVelocity - 8);
    if (seventh) add(seventh, 2, 1, baseVelocity - 12);
    return;
  }

  if (style === 'jazz') {
    // Walking bass: root, third, fifth, chromatic approach to the next root.
    const approach = (nextChord?.bassMidi ?? bass + 5) - 1;
    add(bass, 0, 1, baseVelocity);
    add(third, 1, 1, baseVelocity - 4);
    add(fifth, 2, 1, baseVelocity - 6);
    add(approach, 3, 1, baseVelocity - 4);
    add(third, 2, 1, baseVelocity - 14);
    add(seventh ?? fifth, 2, 1, baseVelocity - 16);
    add(third, 3.5, 0.5, baseVelocity - 18);
    return;
  }

  if (style === 'pop') {
    add(bass, 0, 1, baseVelocity);
    add(bass + 12, 0, 1, baseVelocity - 6);
    add(third, 1, 1, baseVelocity - 8);
    add(fifth, 1, 1, baseVelocity - 8);
    add(bass, 2, 1, baseVelocity);
    add(bass + 12, 2, 1, baseVelocity - 6);
    add(third, 3, 1, baseVelocity - 8);
    add(fifth, 3, 1, baseVelocity - 8);
    if (difficulty === 'advanced') {
      add(seventh ?? fifth, 3.5, 0.5, baseVelocity - 12);
      add(third, 3.5, 0.5, baseVelocity - 14);
    }
    return;
  }

  if (style === 'romantic') {
    const pattern = seventh
      ? [bass, fifth, third, seventh, fifth, third, seventh, fifth]
      : [bass, fifth, third, fifth, bass + 12, fifth, third, fifth];
    pattern.forEach((midi, index) => {
      add(midi, index * 0.5, 0.5, baseVelocity - (index % 2 === 0 ? 0 : 7));
    });
    return;
  }

  if (difficulty === 'advanced') {
    const pattern = [
      bass,
      fifth,
      third,
      fifth,
      seventh ?? bass + 12,
      fifth,
      third,
      fifth,
    ];
    pattern.forEach((midi, index) => {
      add(midi, index * 0.5, 0.5, baseVelocity - (index % 2 === 0 ? 0 : 6));
    });
    return;
  }

  // Classical Alberti bass, 8 eighths per 4/4 bar.
  const pattern = [bass, fifth, third, fifth, bass, fifth, third, fifth];
  pattern.forEach((midi, index) => {
    add(midi, index * 0.5, 0.5, baseVelocity - (index % 2 === 0 ? 2 : 8));
  });
}

/* --------------------------------------------------------------- melody */

const RHYTHMS: Record<AiTimeSignature, Record<AiDifficulty, string[]>> = {
  '4/4': {
    easy: ['2,2', '4', '1,1,2', '2,1,1', '1,1,1,1'],
    medium: [
      '1,0.5,0.5,1,1',
      '0.5,0.5,1,1,1',
      '1,1,1,1',
      '1.5,0.5,1,1',
      '2,1,1',
    ],
    advanced: [
      '0.5,0.5,0.5,0.5,1,1',
      '0.5,0.5,1,1,1',
      '1,0.5,0.5,1,1',
      '0.5,0.5,0.5,0.5,0.5,0.5,1',
      '1.5,0.5,2',
    ],
  },
  '3/4': {
    easy: ['3', '1,2', '2,1', '1,1,1'],
    medium: ['1,1,1', '1.5,1.5', '0.5,0.5,1,1', '2,1'],
    advanced: ['0.5,0.5,0.5,0.5,1', '1,0.5,0.5,1', '0.5,0.5,0.5,0.5,0.5,0.5', '1.5,1.5'],
  },
  '6/8': {
    easy: ['1.5,1.5', '3', '1,1,1'],
    medium: ['1,1,1', '1.5,1.5', '0.5,0.5,0.5,0.5,0.5,0.5', '1,0.5,0.5,1'],
    advanced: ['0.5,0.5,0.5,0.5,0.5,0.5', '1.5,0.5,0.5,0.5', '1,1,1', '1.5,1.5'],
  },
};

function parseRhythmCell(cell: string): number[] {
  return cell.split(',').map((part) => Number(part.trim())).filter((value) => value > 0);
}

function rhythmForPhrase(
  bars: number,
  beatsPerBar: number,
  signature: AiTimeSignature,
  difficulty: AiDifficulty,
  rng: Rng,
): number[] {
  const cells = RHYTHMS[signature][difficulty];
  const result: number[] = [];
  let previous = rng.pick(cells);
  for (let bar = 0; bar < bars; bar += 1) {
    const cell = bar > 0 && rng.chance(0.3) ? previous : rng.pick(cells);
    previous = cell;
    const durations = parseRhythmCell(cell);
    const sum = durations.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - beatsPerBar) > 1e-6) {
      result.push(beatsPerBar);
    } else {
      result.push(...durations);
    }
  }
  return result;
}

function pitchClassesForChord(chord: Chord): Set<number> {
  return new Set(chord.intervals.map((interval) => (chord.rootPc + interval) % 12));
}

function pickMelodyPitch(
  previous: number,
  chordTones: Set<number>,
  scaleTones: Set<number>,
  strong: boolean,
  register: number,
  difficulty: AiDifficulty,
  rng: Rng,
  allowLeap: boolean,
): number {
  const low = 60 + register;
  const high = (difficulty === 'easy' ? 84 : 88) + register;
  const pool = strong && chordTones.size >= 2 ? chordTones : scaleTones;
  const candidates: number[] = [];
  for (let midi = low; midi <= high; midi += 1) {
    if (pool.has(((midi % 12) + 12) % 12)) candidates.push(midi);
  }
  if (!candidates.length) return clamp(previous, low, high);

  const sorted = candidates
    .map((midi) => ({ midi, distance: Math.abs(midi - previous) }))
    .sort((a, b) => a.distance - b.distance);

  // Prefer nearby notes; occasionally leap for expression.
  const leap = allowLeap && rng.chance(difficulty === 'advanced' ? 0.2 : 0.1);
  const poolSize = leap ? Math.min(sorted.length, 6) : Math.min(sorted.length, 3);
  const pickIndex = Math.min(
    poolSize - 1,
    Math.floor(rng.next() * poolSize + (leap ? 2 : 0)),
  );
  let chosen = sorted[Math.max(0, pickIndex)].midi;

  // Avoid repeating the same pitch too often.
  if (chosen === previous && sorted.length > 1 && rng.chance(0.7)) {
    chosen = sorted[1].midi;
  }
  return chosen;
}

function melodyForSection(
  notes: NoteEvent[],
  section: FormSection,
  bars: Chord[],
  beatsPerBar: number,
  signature: AiTimeSignature,
  difficulty: AiDifficulty,
  mode: 'major' | 'minor',
  keyRoot: number,
  rng: Rng,
  seed: number,
  isFinalSection: boolean,
): void {
  if (section.kind === 'intro' || section.kind === 'coda' || section.bars <= 0) return;
  const scale = mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  const scaleTones = new Set(scale.map((interval) => (keyRoot + interval) % 12));
  const register = section.kind === 'B' ? 7 : 0;
  const startBar = section.startBar;
  let previous = 67 + register;
  let counter = notes.length;
  const restProbability =
    difficulty === 'easy' || section.kind === 'B' ? 0.16 : 0.1;

  let bar = 0;
  while (bar < section.bars) {
    const phraseBars = Math.min(4, section.bars - bar);
    const slots = rhythmForPhrase(
      phraseBars,
      beatsPerBar,
      signature,
      difficulty,
      rng,
    );
    let offset = 0;
    let slotIndex = 0;
    for (const duration of slots) {
      const absoluteBar = startBar + bar + Math.floor(offset / beatsPerBar);
      const chord = bars[clamp(absoluteBar, 0, bars.length - 1)];
      const beatInBar = offset % beatsPerBar;
      const strong =
        beatInBar < 1e-6 ||
        Math.abs(beatInBar - beatsPerBar / 2) < 1e-6 ||
        Math.abs(beatInBar - Math.floor(beatsPerBar)) < 1e-6;
      const isLastSlot = slotIndex === slots.length - 1;
      const isFirstSlot = slotIndex === 0;
      const skip =
        !isFirstSlot &&
        !isLastSlot &&
        rng.chance(restProbability) &&
        duration >= 0.5;

      if (!skip) {
        const chordTones = pitchClassesForChord(chord);
        let midi = pickMelodyPitch(
          previous,
          chordTones,
          scaleTones,
          strong,
          register,
          difficulty,
          rng,
          section.kind !== 'A' || difficulty === 'advanced',
        );
        let noteDuration = duration;

        if (isLastSlot) {
          const cadence = strong ? chordTones : scaleTones;
          const target = 67 + register;
          const candidates = [...cadence]
            .map((pc) => {
              let value = 60 + register;
              while (((value % 12) + 12) % 12 !== pc) value += 1;
              return value;
            })
            .sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
          if (candidates.length) midi = candidates[0];
          if (isFinalSection && bar + phraseBars >= section.bars) {
            midi = 60 + register + ((keyRoot - 60 + 120) % 12);
            noteDuration = Math.max(duration, 3);
          } else {
            noteDuration = Math.max(duration, 1.5);
          }
        }

        const accent = beatInBar < 1e-6 ? 12 : strong ? 6 : 0;
        const velocity =
          70 + accent + rng.int(-5, 5) + (difficulty === 'advanced' ? 3 : 0);
        notes.push(
          makeNote(
            `ai-${seed}-${counter++}`,
            midi,
            (startBar + bar) * beatsPerBar + offset,
            noteDuration,
            velocity,
            'right',
          ),
        );
        previous = midi;
      }
      offset += duration;
      slotIndex += 1;
    }
    bar += phraseBars;
  }
}

function addCoda(
  notes: NoteEvent[],
  bars: Chord[],
  totalBars: number,
  codaBars: number,
  beatsPerBar: number,
  keyRoot: number,
  mode: 'major' | 'minor',
  seed: number,
): void {
  if (codaBars <= 0) return;
  const codaStartBar = totalBars - codaBars;
  // Remove generated melody inside the coda.
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    if (notes[i].hand === 'right' && notes[i].start >= codaStartBar * beatsPerBar) {
      notes.splice(i, 1);
    }
  }
  let counter = notes.length;
  const finalBar = codaStartBar + codaBars - 1;
  const finalChord = makeChord(0, keyRoot, mode, 'romantic', 'medium');
  const scale = mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;

  if (codaBars >= 2) {
    const approachBar = codaStartBar;
    const descend = [7, 6, 5, 4, 3, 2, 1, 0];
    descend.forEach((degree, index) => {
      const interval = scale[degree % 7] + (degree >= 7 ? 12 : 0);
      const midi = 60 + ((keyRoot + interval) % 12) + Math.floor((keyRoot + interval) / 12) * 0;
      const start = approachBar * beatsPerBar + index * (beatsPerBar / 8);
      notes.push(
        makeNote(
          `ai-${seed}-${counter++}`,
          midi + 12,
          start,
          beatsPerBar / 8,
          62 + index,
          'right',
        ),
      );
    });
  }

  // Final tonic chord in both hands.
  const finalStart = finalBar * beatsPerBar;
  const root = finalChord.bassMidi;
  const third = root + finalChord.intervals[1];
  const fifth = root + finalChord.intervals[2];
  notes.push(
    makeNote(`ai-${seed}-${counter++}`, root, finalStart, beatsPerBar, 66, 'left'),
  );
  notes.push(
    makeNote(`ai-${seed}-${counter++}`, root + 12, finalStart, beatsPerBar, 58, 'left'),
  );
  notes.push(
    makeNote(`ai-${seed}-${counter++}`, third + 12, finalStart, beatsPerBar, 72, 'right'),
  );
  notes.push(
    makeNote(`ai-${seed}-${counter++}`, fifth + 12, finalStart, beatsPerBar, 70, 'right'),
  );
  notes.push(
    makeNote(
      `ai-${seed}-${counter++}`,
      root + 24 + ((keyRoot - root) % 12 + 12) % 12,
      finalStart,
      beatsPerBar,
      74,
      'right',
    ),
  );
}

/* ---------------------------------------------------------------- public */

export function composePianoPiece(options: AiComposeOptions = {}): AiComposition {
  const seed = Number.isFinite(options.seed) ? Math.floor(options.seed as number) : 12345;
  const rng = new Rng(seed);
  const style = options.style ?? 'romantic';
  const mood = options.mood ?? 'dreamy';
  const difficulty = options.difficulty ?? 'medium';
  const timeSignature = options.timeSignature ?? STYLE_DEFAULTS[style].time;
  const beatsPerBar = beatsPerBarFor(timeSignature);
  const barsRequested = options.bars ?? 16;
  const bars = clamp(Math.round(barsRequested / 4) * 4, 4, 48);
  const mode =
    options.mode ?? (mood === 'melancholic' || mood === 'epic' ? 'minor' : 'major');
  const keyRoot = ((Number.isFinite(options.keyRoot) ? (options.keyRoot as number) : 0) % 12 + 12) % 12;
  const key = keyFor(keyRoot, mode);
  const bpm = clamp(
    options.bpm ??
      STYLE_DEFAULTS[style].tempo + MOOD_TEMPO[mood] + DIFFICULTY_TEMPO[difficulty],
    45,
    180,
  );

  const form = buildForm(bars);
  const progression = PROGRESSIONS[style][mode];
  const progressionA = rng.pick(progression);
  const progressionB = rng.pick(progression.filter((item) => item !== progressionA)) ?? progression[0];

  const barChords: Chord[] = [];
  const barSection: FormSection[] = [];
  for (const section of form) {
    const progressionForSection =
      section.kind === 'B' ? progressionB : progressionA;
    for (let i = 0; i < section.bars; i += 1) {
      const degree = progressionForSection[i % progressionForSection.length];
      barChords.push(makeChord(degree, keyRoot, mode, style, difficulty));
      barSection.push(section);
    }
  }

  const notes: NoteEvent[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const section = barSection[bar];
    const chord = barChords[bar];
    const next = barChords[Math.min(bar + 1, bars - 1)];
    const barStart = bar * beatsPerBar;
    const isIntro = section.kind === 'intro';
    const isCoda = section.kind === 'coda';
    if (isCoda && bar < bars - 1) {
      // Coda accompaniment is added with the final chord below; keep a sparse bass.
      leftHandBar(
        notes,
        chord,
        next,
        barStart,
        beatsPerBar,
        'ambient',
        difficulty,
        rng,
        timeSignature,
        seed,
      );
      continue;
    }
    if (isCoda) continue;
    leftHandBar(
      notes,
      chord,
      next,
      barStart,
      beatsPerBar,
      isIntro ? 'ambient' : style,
      difficulty,
      rng,
      timeSignature,
      seed,
    );
  }

  const sectionsToVoice = form.filter((section) => section.kind !== 'intro' && section.kind !== 'coda');
  for (const section of sectionsToVoice) {
    melodyForSection(
      notes,
      section,
      barChords,
      beatsPerBar,
      timeSignature,
      difficulty,
      mode,
      keyRoot,
      rng,
      seed,
      section === sectionsToVoice[sectionsToVoice.length - 1],
    );
  }

  const codaSection = form.find((section) => section.kind === 'coda');
  addCoda(
    notes,
    barChords,
    bars,
    codaSection?.bars ?? 0,
    beatsPerBar,
    keyRoot,
    mode,
    seed,
  );

  // Small pickup: a single note before the first full melody bar, if there is room.
  const firstMelodySection = form.find(
    (section) => section.kind === 'A' || section.kind === 'A2',
  );
  if (firstMelodySection && firstMelodySection.startBar > 0) {
    const pickupStart = firstMelodySection.startBar * beatsPerBar - 0.5;
    notes.push(
      makeNote(
        `ai-${seed}-pickup`,
        60 + ((keyRoot - 60 + 120) % 12) + 12,
        pickupStart,
        0.5,
        62,
        'right',
      ),
    );
  }

  const titleBase = rng.pick(TITLE_BANK[mood]);
  const title = `${titleBase} in ${key.name}`;
  const styleLabel = AI_STYLES.find((entry) => entry.value === style)?.label ?? style;
  const moodLabel = AI_MOODS.find((entry) => entry.value === mood)?.label ?? mood;
  const description = `${moodLabel} ${styleLabel.toLowerCase()} in ${key.name} — ${bars} bars at ${bpm} BPM. Generated locally with seed ${seed}.`;

  const totalBeats = bars * beatsPerBar;
  const clippedNotes = notes
    .filter((note) => note.start < totalBeats - 1e-9)
    .map((note) => ({
      ...note,
      duration: Math.min(note.duration, totalBeats - note.start),
    }))
    .filter((note) => note.duration >= 0.125);

  const score = createScore({
    title,
    composer: 'Piano Studio AI',
    notes: clippedNotes,
    tempo: [{ beat: 0, bpm }],
    timeSignatures: [
      {
        beat: 0,
        numerator: timeSignature === '3/4' ? 3 : timeSignature === '6/8' ? 6 : 4,
        denominator: timeSignature === '6/8' ? 8 : 4,
      },
    ],
    keySignature: { fifths: key.fifths, mode: key.mode },
    source: 'builtin',
    lengthBeats: totalBeats,
  });

  return {
    score,
    meta: {
      title,
      description,
      style,
      mood,
      keyName: key.name,
      bars,
      bpm,
      timeSignature,
      difficulty,
      seed,
    },
  };
}
