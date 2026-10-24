import type { Hand, NoteEvent, Score } from './types';
import { nameToMidi } from './pitch';
import { createScore } from './score';

type Spec = [pitch: string | null, duration: number];

let demoSeed = 0;

function note(name: string, start: number, duration: number, hand: Hand, velocity: number): NoteEvent {
  const midi = nameToMidi(name);
  if (midi === null) throw new Error(`Bad demo pitch: ${name}`);
  demoSeed += 1;
  return {
    id: `demo-${demoSeed}`,
    midi,
    start,
    duration,
    velocity,
    hand,
    track: hand === 'right' ? 0 : 1,
  };
}

function line(hand: Hand, start: number, specs: Spec[], velocity = 80): NoteEvent[] {
  const notes: NoteEvent[] = [];
  let t = start;
  for (const [pitch, duration] of specs) {
    if (pitch) notes.push(note(pitch, t, duration, hand, velocity));
    t += duration;
  }
  return notes;
}

function chords(start: number, duration: number, pitches: string[][], hand: Hand, velocity = 62): NoteEvent[] {
  return pitches.flatMap((chord, index) =>
    chord.map((pitch) => note(pitch, start + index * duration, duration, hand, velocity)),
  );
}

function twinkle(): Score {
  const r = line('right', 0, [
    ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1],
    ['A4', 1], ['A4', 1], ['G4', 2],
    ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1],
    ['D4', 1], ['D4', 1], ['C4', 2],
    ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1],
    ['E4', 1], ['E4', 1], ['D4', 2],
    ['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1],
    ['E4', 1], ['E4', 1], ['D4', 2],
    ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1],
    ['A4', 1], ['A4', 1], ['G4', 2],
    ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1],
    ['D4', 1], ['D4', 1], ['C4', 2],
  ]);
  const l = chords(0, 4, [
    ['C3', 'E3', 'G3'],
    ['F2', 'A2', 'C3'],
    ['C3', 'E3', 'G3'],
    ['G2', 'B2', 'D3'],
    ['C3', 'E3', 'G3'],
    ['F2', 'A2', 'C3'],
    ['C3', 'E3', 'G3'],
    ['G2', 'B2', 'D3'],
    ['C3', 'E3', 'G3'],
    ['F2', 'A2', 'C3'],
    ['G2', 'B2', 'D3'],
    ['C3', 'E3', 'G3'],
  ], 'left');
  return createScore({
    id: 'demo-twinkle',
    title: 'Twinkle, Twinkle, Little Star',
    composer: 'Traditional',
    notes: [...r, ...l],
    tempo: [{ beat: 0, bpm: 116 }],
    timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }],
    keySignature: { fifths: 0, mode: 'major' },
    source: 'builtin',
    lengthBeats: 48,
  });
}

function odeToJoy(): Score {
  const r = line('right', 0, [
    ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1],
    ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
    ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1],
    ['E4', 1.5], ['D4', 0.5], ['D4', 2],
    ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1],
    ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
    ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1],
    ['D4', 1.5], ['C4', 0.5], ['C4', 2],
  ]);
  const l = chords(0, 4, [
    ['C3', 'E3', 'G3'],
    ['G2', 'B2', 'D3'],
    ['C3', 'E3', 'G3'],
    ['G2', 'B2', 'D3'],
    ['C3', 'E3', 'G3'],
    ['G2', 'B2', 'D3'],
    ['C3', 'E3', 'G3'],
    ['C3', 'E3', 'G3'],
  ], 'left');
  return createScore({
    id: 'demo-ode',
    title: 'Ode to Joy',
    composer: 'Ludwig van Beethoven',
    notes: [...r, ...l],
    tempo: [{ beat: 0, bpm: 100 }],
    timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }],
    keySignature: { fifths: 0, mode: 'major' },
    source: 'builtin',
    lengthBeats: 32,
  });
}

function furElise(): Score {
  const phrase = (start: number) => [
    ...line('right', start, [
      ['E5', 0.25], ['D#5', 0.25], ['E5', 0.25], ['D#5', 0.25], ['E5', 0.25], ['B4', 0.25],
    ]),
    ...line('right', start + 1.5, [['D5', 0.25], ['C5', 0.25], ['A4', 1]]),
    ...line('left', start, [['A2', 0.5], ['E3', 0.5], ['A3', 0.5]]),
    ...line('left', start + 1.5, [['A2', 0.5], ['E3', 0.5], ['A3', 0.5]]),
  ];
  const r = [...phrase(0), ...phrase(3), ...phrase(6)];
  return createScore({
    id: 'demo-furelise',
    title: 'Für Elise (opening)',
    composer: 'Ludwig van Beethoven',
    notes: r,
    tempo: [{ beat: 0, bpm: 76 }],
    timeSignatures: [{ beat: 0, numerator: 3, denominator: 8 }],
    keySignature: { fifths: 0, mode: 'minor' },
    source: 'builtin',
    lengthBeats: 9,
  });
}

function canon(): Score {
  const r = line('right', 0, [
    ['F#5', 2], ['E5', 2],
    ['D5', 2], ['C#5', 2],
    ['B4', 2], ['A4', 2],
    ['B4', 2], ['C#5', 2],
    ['D5', 2], ['C#5', 2],
    ['B4', 2], ['A4', 2],
    ['G4', 2], ['F#4', 2],
    ['G4', 2], ['E4', 2],
  ]);
  const l = line('left', 0, [
    ['D3', 2], ['A2', 2], ['B2', 2], ['F#2', 2],
    ['G2', 2], ['D2', 2], ['G2', 2], ['A2', 2],
    ['D3', 2], ['A2', 2], ['B2', 2], ['F#2', 2],
    ['G2', 2], ['D2', 2], ['G2', 2], ['A2', 2],
  ], 58);
  return createScore({
    id: 'demo-canon',
    title: 'Canon in D (theme)',
    composer: 'Johann Pachelbel',
    notes: [...r, ...l],
    tempo: [{ beat: 0, bpm: 64 }],
    timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }],
    keySignature: { fifths: 2, mode: 'major' },
    source: 'builtin',
    lengthBeats: 32,
  });
}

function cMajorScale(): Score {
  const up = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'];
  const down = ['B4', 'A4', 'G4', 'F4', 'E4', 'D4'];
  const r = line('right', 0, [
    ...up.map((pitch): Spec => [pitch, 1] as Spec),
    ...down.map((pitch): Spec => [pitch, 1] as Spec),
    ['C4', 1],
  ]);
  const l = chords(0, 4, [
    ['C3', 'E3', 'G3'],
    ['F2', 'A2', 'C3'],
    ['G2', 'B2', 'D3'],
    ['C3', 'E3', 'G3'],
  ], 'left', 58);
  return createScore({
    id: 'demo-scale',
    title: 'C Major Scale (warm-up)',
    composer: 'Piano Studio',
    notes: [...r, ...l],
    tempo: [{ beat: 0, bpm: 96 }],
    timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }],
    keySignature: { fifths: 0, mode: 'major' },
    source: 'builtin',
    lengthBeats: 16,
  });
}

export const DEMO_SONGS: Score[] = [twinkle(), odeToJoy(), furElise(), canon(), cMajorScale()];
