import type { Hand } from './types';

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Scientific pitch notation: MIDI 60 => "C4". */
export function midiToName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${PITCH_NAMES[pc]}${octave}`;
}

/** e.g. "C" and 4. */
export function midiToParts(midi: number): { pitchClass: string; octave: number } {
  return {
    pitchClass: PITCH_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
  };
}

/** Parses "C4", "F#3", "Bb2" into a MIDI number (or null when invalid). */
export function nameToMidi(name: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const accidental = m[2];
  const octave = Number(m[3]);
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semitone = base[letter];
  if (semitone === undefined) return null;
  if (accidental === '#') semitone += 1;
  if (accidental === 'b') semitone -= 1;
  return (octave + 1) * 12 + semitone;
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Default split point between hands: notes below middle C go to the left hand. */
export function defaultHandForMidi(midi: number, split = 60): Hand {
  return midi < split ? 'left' : 'right';
}

/** Note letter (without accidental), e.g. "C#4" -> "C". */
export function noteLetter(midi: number): string {
  return PITCH_NAMES[((midi % 12) + 12) % 12][0];
}

/** Number of sharps/flats (accidental in a key signature) for a pitch class. */
export function accidentalForPitch(pitchClass: number, fifths: number): '#' | 'b' | '' {
  const sharpOrder = [6, 1, 8, 3, 10, 5, 0]; // F C G D A E B
  const flatOrder = [10, 3, 8, 1, 6, 11, 4]; // B E A D G C F
  if (fifths > 0) {
    const needed = sharpOrder.slice(0, Math.min(7, fifths));
    return needed.includes(pitchClass) ? '#' : '';
  }
  if (fifths < 0) {
    const needed = flatOrder.slice(0, Math.min(7, -fifths));
    return needed.includes(pitchClass) ? 'b' : '';
  }
  return '';
}

/** Human-friendly key label, e.g. `Eb4`, honouring a key signature. */
export function midiToKeyName(midi: number, fifths = 0): string {
  const pc = ((midi % 12) + 12) % 12;
  const acc = accidentalForPitch(pc, fifths);
  const flatMap: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' };
  let base: string = PITCH_NAMES[pc];
  if (acc === 'b') base = flatMap[base] ?? base;
  const octave = Math.floor(midi / 12) - 1;
  return `${base}${octave}`;
}

export const MIN_PIANO_MIDI = 21; // A0
export const MAX_PIANO_MIDI = 108; // C8
export const MIDDLE_C = 60;
