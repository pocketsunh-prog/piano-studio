/** Shared QWERTY → MIDI mapping used by the app keyboard and the games. */

/** letter -> semitone offset from the C of the selected octave. */
export const QWERTY_KEYMAP: Readonly<Record<string, number>> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
};

export const WHITE_KEY_LETTERS = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k'] as const;
export const BLACK_KEY_LETTERS = ['w', 'e', 't', 'y', 'u'] as const;

export const MIN_OCTAVE = 1;
export const MAX_OCTAVE = 7;

/** C of an octave in MIDI numbers (C4 = 60). */
export function octaveBaseMidi(octave: number): number {
  return (octave + 1) * 12;
}

/** The QWERTY letter for a MIDI key given the selected octave, if any. */
export function qwertyLabelForMidi(midi: number, octave: number): string | null {
  const offset = midi - octaveBaseMidi(octave);
  for (const [letter, semitone] of Object.entries(QWERTY_KEYMAP)) {
    if (semitone === offset) return letter.toUpperCase();
  }
  return null;
}

/** Which MIDI note a QWERTY letter triggers at the given octave. */
export function midiForKey(letter: string, octave: number): number | null {
  const offset = QWERTY_KEYMAP[letter.toLowerCase()];
  return offset === undefined ? null : octaveBaseMidi(octave) + offset;
}
