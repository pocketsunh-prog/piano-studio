import { describe, expect, it } from 'vitest';
import type { NoteEvent, Score } from '../music/types';
import { createScore } from '../music/score';
import {
  DISPLAY_GRID,
  activeNoteIds,
  buildDisplayModel,
  groupIntoVoices,
  keySignatureSpec,
  measureIndexAtBeat,
  measureify,
  midiToVexKey,
  prepareNotes,
  quantizeBeats,
  splitBeats,
  staffForNote,
  timeSignatureSpec,
  toVexDuration,
  type PreparedNote,
} from './notation';

function note(
  id: string,
  midi: number,
  start: number,
  duration: number,
  hand: 'left' | 'right' = 'right',
  extra: Partial<NoteEvent> = {},
): NoteEvent {
  return { id, midi, start, duration, velocity: 80, hand, ...extra };
}

function scoreOf(notes: NoteEvent[], extra: Partial<Parameters<typeof createScore>[0]> = {}): Score {
  return createScore({
    title: 'test',
    notes,
    ...extra,
  });
}

function prepared(
  id: string,
  midi: number,
  start: number,
  duration: number,
  hand: 'left' | 'right' = 'right',
): PreparedNote {
  return {
    id,
    midi,
    start,
    duration,
    hand,
    staff: staffForNote({ midi, hand }),
  };
}

/** A note with no usable `hand` field (simulates malformed imported data). */
function noteWithoutHand(id: string, midi: number, start: number, duration: number): NoteEvent {
  return { id, midi, start, duration, velocity: 80 } as unknown as NoteEvent;
}

/** A hand-built score that bypasses `createScore` normalisation. */
function rawScore(notes: NoteEvent[], lengthBeats = 8): Score {
  return {
    id: 'raw',
    title: 'raw',
    composer: '',
    notes,
    tempo: [{ beat: 0, bpm: 120 }],
    timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }],
    keySignature: { fifths: 0, mode: 'major' },
    ppq: 480,
    source: 'builtin',
    lengthBeats,
  };
}

describe('quantizeBeats', () => {
  it('snaps to the 1/16 note grid by default', () => {
    expect(DISPLAY_GRID).toBe(0.25);
    expect(quantizeBeats(0.1)).toBe(0);
    expect(quantizeBeats(0.13)).toBe(0.25);
    expect(quantizeBeats(1.01)).toBe(1);
    expect(quantizeBeats(1.13)).toBe(1.25);
    expect(quantizeBeats(3.9)).toBe(4);
  });

  it('handles bad input defensively', () => {
    expect(quantizeBeats(Number.NaN)).toBe(0);
    expect(quantizeBeats(1, 0)).toBe(1);
  });
});

describe('toVexDuration / splitBeats', () => {
  it('maps common durations directly', () => {
    expect(toVexDuration(4)).toMatchObject({ duration: 'w', dots: 0 });
    expect(toVexDuration(3)).toMatchObject({ duration: 'h', dots: 1 });
    expect(toVexDuration(2)).toMatchObject({ duration: 'h', dots: 0 });
    expect(toVexDuration(1.5)).toMatchObject({ duration: 'q', dots: 1 });
    expect(toVexDuration(1)).toMatchObject({ duration: 'q', dots: 0 });
    expect(toVexDuration(0.75)).toMatchObject({ duration: '8', dots: 1 });
    expect(toVexDuration(0.5)).toMatchObject({ duration: '8', dots: 0 });
    expect(toVexDuration(0.25)).toMatchObject({ duration: '16', dots: 0 });
  });

  it('returns null for lengths that need ties', () => {
    expect(toVexDuration(1.25)).toBeNull();
    expect(toVexDuration(0)).toBeNull();
    expect(toVexDuration(Number.NaN)).toBeNull();
  });

  it('splits odd lengths into representable tied segments', () => {
    const cases = [1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.5, 5.25, 5.75, 6];
    for (const beats of cases) {
      const parts = splitBeats(beats);
      expect(parts.length).toBeGreaterThan(0);
      const total = parts.reduce((sum, part) => sum + part.beats, 0);
      expect(total).toBeCloseTo(beats, 6);
      for (const part of parts) {
        expect(toVexDuration(part.beats)).toMatchObject({ duration: part.duration, dots: part.dots });
      }
    }
  });

  it('splits 1.25 beats into a quarter tied to a sixteenth', () => {
    expect(splitBeats(1.25).map((part) => part.duration)).toEqual(['q', '16']);
  });

  it('returns nothing for non-positive lengths', () => {
    expect(splitBeats(0)).toEqual([]);
    expect(splitBeats(-1)).toEqual([]);
  });
});

describe('pitch / key helpers', () => {
  it('spells keys according to the key signature', () => {
    expect(midiToVexKey(60, 0).key).toBe('c/4');
    expect(midiToVexKey(61, 0).key).toBe('c#/4');
    expect(midiToVexKey(61, -5).key).toBe('db/4');
    expect(midiToVexKey(70, -2).key).toBe('bb/4');
    expect(midiToVexKey(66, 2).key).toBe('f#/4');
    expect(midiToVexKey(21, 0).key).toBe('a/0');
    expect(midiToVexKey(108, 0).key).toBe('c/8');
  });

  it('clamps out-of-range MIDI numbers', () => {
    expect(midiToVexKey(-20, 0).key).toBe('a/0');
    expect(midiToVexKey(500, 0).key).toBe('c/8');
    expect(midiToVexKey(Number.NaN, 0).key).toBe('c/4');
  });

  it('maps key signatures', () => {
    expect(keySignatureSpec({ fifths: 0, mode: 'major' })).toBe('C');
    expect(keySignatureSpec({ fifths: 2, mode: 'major' })).toBe('D');
    expect(keySignatureSpec({ fifths: -3, mode: 'major' })).toBe('Eb');
    expect(keySignatureSpec({ fifths: 7, mode: 'major' })).toBe('C#');
    expect(keySignatureSpec({ fifths: -7, mode: 'major' })).toBe('Cb');
    expect(keySignatureSpec({ fifths: 0, mode: 'minor' })).toBe('Am');
    expect(keySignatureSpec({ fifths: -1, mode: 'minor' })).toBe('Dm');
    expect(keySignatureSpec({ fifths: 3, mode: 'minor' })).toBe('F#m');
    expect(keySignatureSpec(undefined)).toBe('C');
  });

  it('formats time signatures', () => {
    expect(timeSignatureSpec({ numerator: 4, denominator: 4 })).toBe('4/4');
    expect(timeSignatureSpec({ numerator: 3, denominator: 8 })).toBe('3/8');
    expect(timeSignatureSpec({ numerator: 0, denominator: 0 })).toBe('4/4');
  });
});

describe('staffForNote', () => {
  it('uses the hand when available', () => {
    expect(staffForNote({ midi: 80, hand: 'left' })).toBe('bass');
    expect(staffForNote({ midi: 40, hand: 'right' })).toBe('treble');
  });

  it('falls back to a pitch split at middle C', () => {
    expect(staffForNote({ midi: 59, hand: undefined as unknown as 'left' })).toBe('bass');
    expect(staffForNote({ midi: 60, hand: undefined as unknown as 'left' })).toBe('treble');
    expect(staffForNote({ midi: 72, hand: 'bogus' as unknown as 'left' })).toBe('treble');
    expect(staffForNote({ midi: 30, hand: 'bogus' as unknown as 'left' })).toBe('bass');
  });
});

describe('prepareNotes', () => {
  it('quantizes copies without mutating the score', () => {
    const score = scoreOf([
      note('a', 60, 0.1, 0.9, 'right'),
      note('b', 64, 1.13, 0.4, 'right'),
      note('c', 48, 2.9, 1.2, 'left'),
    ]);
    const before = JSON.stringify(score);
    const notes = prepareNotes(score);
    expect(notes.map((item) => [item.id, item.start, item.duration])).toEqual([
      ['a', 0, 1],
      ['b', 1.25, 0.5],
      ['c', 3, 1.25],
    ]);
    expect(notes.map((item) => item.staff)).toEqual(['treble', 'treble', 'bass']);
    expect(JSON.stringify(score)).toBe(before);
  });

  it('drops malformed notes and caps huge inputs', () => {
    const score = scoreOf([
      note('bad-start', 60, Number.NaN, 1),
      note('bad-duration', 60, 1, 0),
      note('bad-midi', Number.NaN, 1, 1),
      note('ok', 62, 1, 1),
    ]);
    expect(prepareNotes(score).map((item) => item.id)).toEqual(['ok']);
  });

  it('clamps the minimum display duration to the grid', () => {
    const score = scoreOf([note('tiny', 60, 0, 0.01)]);
    expect(prepareNotes(score)[0]?.duration).toBe(DISPLAY_GRID);
  });
});

describe('groupIntoVoices', () => {
  it('merges notes that share a start and duration into one chord', () => {
    const chords = groupIntoVoices([
      prepared('c', 60, 0, 2),
      prepared('e', 64, 0, 2),
      prepared('g', 67, 0, 2),
    ]);
    expect(chords).toHaveLength(1);
    expect(chords[0]).toMatchObject({ start: 0, duration: 2, midis: [60, 64, 67], voice: 1 });
    expect(chords[0]?.noteIds).toEqual(['c', 'e', 'g']);
  });

  it('keeps sequential notes in voice 1', () => {
    const chords = groupIntoVoices([
      prepared('a', 60, 0, 1),
      prepared('b', 62, 1, 1),
      prepared('c', 64, 2, 1),
    ]);
    expect(chords.map((chord) => chord.voice)).toEqual([1, 1, 1]);
  });

  it('moves overlapping independent lines to voice 2', () => {
    const chords = groupIntoVoices([
      prepared('r1', 72, 0, 2),
      prepared('r2', 74, 2, 2),
      prepared('l1', 48, 0, 4, 'left'),
    ]);
    const byId = new Map(chords.map((chord) => [chord.noteIds[0], chord]));
    expect(byId.get('r1')).toMatchObject({ voice: 1 });
    expect(byId.get('r2')).toMatchObject({ voice: 1 });
    expect(byId.get('l1')).toMatchObject({ staff: 'bass', voice: 1 });
  });

  it('separates genuinely overlapping lines on the same staff', () => {
    const chords = groupIntoVoices([
      prepared('low1', 60, 0, 4),
      prepared('high1', 72, 0, 2),
      prepared('high2', 74, 2, 1),
    ]);
    const voiceOf = new Map(chords.map((chord) => [chord.noteIds[0], chord.voice]));
    expect(voiceOf.get('low1')).toBe(1);
    expect(voiceOf.get('high1')).toBe(2);
    expect(voiceOf.get('high2')).toBe(2);
    expect(chords.every((chord) => chord.voice === 1 || chord.voice === 2)).toBe(true);
  });

  it('honours the optional voice hint', () => {
    const chords = groupIntoVoices([
      { ...prepared('a', 60, 0, 4), voiceHint: 2 },
      prepared('b', 72, 0, 2),
    ]);
    const voiceOf = new Map(chords.map((chord) => [chord.noteIds[0], chord.voice]));
    expect(voiceOf.get('a')).toBe(2);
    expect(voiceOf.get('b')).toBe(1);
  });

  it('orders chords by start time and staff', () => {
    const chords = groupIntoVoices([
      prepared('bass', 40, 1, 1, 'left'),
      prepared('treble', 72, 0, 1),
    ]);
    expect(chords.map((chord) => chord.noteIds[0])).toEqual(['treble', 'bass']);
  });
});

describe('measureify', () => {
  it('produces one measure with notes on both staves', () => {
    const score = scoreOf([
      note('r1', 72, 0, 1),
      note('r2', 74, 1, 1),
      note('r3', 76, 2, 1),
      note('r4', 77, 3, 1),
      note('l1', 48, 0, 4, 'left'),
    ]);
    const measures = measureify(score);
    expect(measures).toHaveLength(1);
    expect(measures[0]?.beats).toBe(4);
    expect(measures[0]?.events.treble.filter((event) => event.kind === 'note')).toHaveLength(4);
    expect(measures[0]?.events.bass.filter((event) => event.kind === 'note')).toHaveLength(1);
    expect(measures[0]?.events.treble.every((event) => event.voice === 1)).toBe(true);
  });

  it('fills gaps and empty measures with rests', () => {
    const score = scoreOf([note('a', 72, 2, 1)]);
    const measure = measureify(score)[0];
    expect(measure).toBeDefined();
    if (!measure) return;
    expect(measure.events.bass.every((event) => event.kind === 'rest')).toBe(true);
    const bassTotal = measure.events.bass.reduce((sum, event) => sum + event.beats, 0);
    expect(bassTotal).toBeCloseTo(4, 6);
    const treble = measure.events.treble;
    expect(treble.map((event) => [event.kind, event.offset])).toEqual([
      ['rest', 0],
      ['note', 2],
      ['rest', 3],
    ]);
  });

  it('fills a completely empty score with whole-measure rests', () => {
    const measures = measureify(scoreOf([]));
    expect(measures).toHaveLength(1);
    expect(measures[0]?.events.treble.length).toBeGreaterThan(0);
    expect(measures[0]?.events.treble.every((event) => event.kind === 'rest')).toBe(true);
    expect(measures[0]?.events.bass.every((event) => event.kind === 'rest')).toBe(true);
  });

  it('splits notes crossing a barline into tied segments', () => {
    const score = scoreOf([note('long', 72, 3.5, 1)]);
    const measures = measureify(score);
    expect(measures.length).toBeGreaterThan(1);
    const first = measures[0]?.events.treble.filter((event) => event.kind === 'note') ?? [];
    const second = measures[1]?.events.treble.filter((event) => event.kind === 'note') ?? [];
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.offset).toBe(3.5);
    expect(first[0]?.beats).toBe(0.5);
    expect(second[0]?.offset).toBe(0);
    expect(first[0]?.tieGroup).toBeDefined();
    expect(first[0]?.tieGroup).toBe(second[0]?.tieGroup);
  });

  it('splits unrepresentable durations into tied pieces', () => {
    const score = scoreOf([note('five16', 72, 0, 1.25)]);
    const events = measureify(score)[0]?.events.treble.filter((event) => event.kind === 'note') ?? [];
    expect(events.length).toBe(2);
    expect(events.map((event) => event.duration)).toEqual(['q', '16']);
    expect(events[0]?.tieGroup).toBe(events[1]?.tieGroup);
  });

  it('respects time-signature changes', () => {
    const score = scoreOf(
      [
        note('a', 72, 0, 3),
        note('b', 74, 3, 2),
      ],
      {
        timeSignatures: [
          { beat: 0, numerator: 3, denominator: 4 },
          { beat: 3, numerator: 2, denominator: 4 },
        ],
      },
    );
    const measures = measureify(score);
    expect(measures.length).toBeGreaterThanOrEqual(2);
    expect(measures[0]?.timeSignature.numerator).toBe(3);
    expect(measures[0]?.timeSignatureChanged).toBe(true);
    expect(measures[1]?.timeSignature.numerator).toBe(2);
    expect(measures[1]?.timeSignatureChanged).toBe(true);
  });

  it('handles 3/8 without collapsing', () => {
    const score = scoreOf([note('a', 72, 0, 0.25)], {
      timeSignatures: [{ beat: 0, numerator: 3, denominator: 8 }],
      lengthBeats: 1.5,
    });
    const measures = measureify(score);
    expect(measures[0]?.beats).toBe(1.5);
    const total = measures[0]?.events.treble.reduce((sum, event) => sum + event.beats, 0) ?? 0;
    expect(total).toBeCloseTo(1.5, 6);
  });

  it('caps the number of rendered measures', () => {
    const notes: NoteEvent[] = [];
    for (let i = 0; i < 300; i += 1) notes.push(note(`n${i}`, 60 + (i % 12), i * 0.25, 0.25));
    const score = scoreOf(notes, { lengthBeats: 75 });
    expect(measureify(score, { maxMeasures: 4 })).toHaveLength(4);
    expect(buildDisplayModel(score).totalMeasures).toBeGreaterThan(4);
  });

  it('falls back to the pitch split for notes without a hand', () => {
    const score = rawScore([noteWithoutHand('low', 40, 0, 1), noteWithoutHand('high', 72, 0, 1)]);
    const measure = measureify(score)[0];
    expect(measure?.events.bass.some((event) => event.noteIds.includes('low'))).toBe(true);
    expect(measure?.events.treble.some((event) => event.noteIds.includes('high'))).toBe(true);
  });

  it('marks simultaneous overlapping lines as two voices', () => {
    const score = scoreOf([
      note('upper', 72, 0, 4),
      note('lower', 60, 0, 4),
      note('middle', 66, 2, 2),
    ]);
    const measure = measureify(score)[0];
    const voices = new Set(measure?.events.treble.map((event) => event.voice));
    expect(voices.has(1)).toBe(true);
    expect(voices.has(2)).toBe(true);
  });
});

describe('highlight helpers', () => {
  const info = [
    { id: 'a', midi: 60, start: 0, end: 1 },
    { id: 'b', midi: 64, start: 1, end: 2 },
    { id: 'c', midi: 67, start: 2, end: 4 },
  ];

  it('finds notes sounding at the current beat', () => {
    expect(activeNoteIds(info, 0.5)).toEqual(['a']);
    expect(activeNoteIds(info, 1)).toEqual(['b']);
    expect(activeNoteIds(info, 2.5)).toEqual(['c']);
    expect(activeNoteIds(info, 5)).toEqual([]);
  });

  it('filters by sounding midi numbers', () => {
    expect(activeNoteIds(info, 2.5, [67])).toEqual(['c']);
    expect(activeNoteIds(info, 2.5, [60])).toEqual([]);
    expect(activeNoteIds(info, 2.5, [])).toEqual(['c']);
  });

  it('tolerates tiny timing jitter before the onset', () => {
    expect(activeNoteIds(info, 0.96, undefined, 0.1)).toEqual(['a', 'b']);
  });
});

describe('measureIndexAtBeat', () => {
  const measures = [
    { start: 0, end: 4 },
    { start: 4, end: 8 },
    { start: 8, end: 12 },
  ];
  it('locates the measure for a beat', () => {
    expect(measureIndexAtBeat(measures, 0)).toBe(0);
    expect(measureIndexAtBeat(measures, 3.9)).toBe(0);
    expect(measureIndexAtBeat(measures, 4)).toBe(1);
    expect(measureIndexAtBeat(measures, 99)).toBe(2);
    expect(measureIndexAtBeat(measures, Number.NaN)).toBe(0);
    expect(measureIndexAtBeat([], 1)).toBe(-1);
  });
});
