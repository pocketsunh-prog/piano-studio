import { describe, expect, it } from 'vitest';
import { createScore } from '../score';
import type { NoteEvent, Score } from '../types';
import { parseMusicXml, writeMusicXml } from './musicxml';
import { SAMPLE_MUSICXML } from './testkit';

function byHandAndMidi(notes: NoteEvent[]): Map<string, NoteEvent> {
  const map = new Map<string, NoteEvent>();
  for (const note of notes) map.set(`${note.hand}:${note.midi}`, note);
  return map;
}

describe('parseMusicXml', () => {
  it('parses chords, staves as hands, a tie across the bar line, backup and two tempo events', () => {
    const score = parseMusicXml(SAMPLE_MUSICXML);

    expect(score.title).toBe('Tie & Chord Study');
    expect(score.composer).toBe('Test Composer');
    expect(score.ppq).toBe(2);
    expect(score.source).toBe('musicxml');
    expect(score.notes).toHaveLength(11);

    // Three-note chord at beat 0 on the right hand.
    const chord = score.notes.filter((note) => note.start === 0 && note.hand === 'right');
    expect(chord.map((note) => note.midi).sort((a, b) => a - b)).toEqual([60, 64, 67]);
    expect(chord.every((note) => Math.abs(note.duration - 1) < 1e-9)).toBe(true);

    // The tied F4 (beat 3 -> 4 plus beat 4 -> 5) must be a single note.
    const tied = score.notes.filter((note) => note.midi === 65);
    expect(tied).toHaveLength(1);
    expect(tied[0].start).toBeCloseTo(3, 9);
    expect(tied[0].duration).toBeCloseTo(2, 9);

    // Staff 2 maps to the left hand.
    const left = score.notes.filter((note) => note.hand === 'left');
    expect(left.map((note) => note.midi).sort((a, b) => a - b)).toEqual([43, 43, 48, 48]);
    expect(left.every((note) => Math.abs(note.duration - 2) < 1e-9)).toBe(true);

    // Tempo: 120 at beat 0, 90 one beat into measure 2 via <offset>.
    expect(score.tempo).toHaveLength(2);
    expect(score.tempo[0].beat).toBeCloseTo(0, 9);
    expect(score.tempo[0].bpm).toBeCloseTo(120, 9);
    expect(score.tempo[1].beat).toBeCloseTo(5, 9);
    expect(score.tempo[1].bpm).toBeCloseTo(90, 9);

    expect(score.timeSignatures).toHaveLength(1);
    expect(score.timeSignatures[0]).toMatchObject({ beat: 0, numerator: 4, denominator: 4 });
    expect(score.keySignature).toEqual({ fifths: -1, mode: 'major' });
    expect(score.lengthBeats).toBeCloseTo(8, 9);
  });

  it('supports metronome-only tempo and <type>/dots as a duration fallback', () => {
    const xml = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Fallback</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><metronome><beat-unit>half</beat-unit><per-minute>60</per-minute></metronome></direction-type></direction>
      <note><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><type>half</type><dot/><staff>1</staff></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><type>quarter</type><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;
    const score = parseMusicXml(xml);
    // A half-note beat unit at 60 per minute = 120 quarter-note bpm.
    expect(score.tempo[0].bpm).toBeCloseTo(120, 9);
    expect(score.title).toBe('Fallback');
    const notes = byHandAndMidi(score.notes);
    expect(notes.get('right:58')?.duration).toBeCloseTo(3, 9); // dotted half
    expect(notes.get('right:72')?.duration).toBeCloseTo(1, 9); // quarter
    expect(notes.get('right:72')?.start).toBeCloseTo(3, 9);
  });

  it('handles an implicit pickup measure and falls back to a pitch split without staves', () => {
    const xml = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Pickup</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1" implicit="yes">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;
    const score = parseMusicXml(xml);
    expect(score.notes).toHaveLength(3);
    const byMidi = byHandAndMidi(score.notes);
    expect(byMidi.get('right:67')?.start).toBeCloseTo(0, 9); // pickup note
    expect(byMidi.get('right:60')?.start).toBeCloseTo(1, 9); // after the 1-beat pickup
    expect(byMidi.get('left:52')?.start).toBeCloseTo(5, 9);
    expect(byMidi.get('left:52')?.hand).toBe('left'); // pitch split at middle C
  });

  it('rejects empty, non-partwise and malformed documents', () => {
    expect(() => parseMusicXml('')).toThrow(/empty/i);
    expect(() => parseMusicXml('   \n  ')).toThrow(/empty/i);

    expect(() => parseMusicXml('not xml at all')).toThrow(/no root element/i);
    expect(() => parseMusicXml('<foo><bar/></foo>')).toThrow(/score-partwise/);
    expect(() => parseMusicXml('<score-partwise><part></score-partwise>')).toThrow(/Invalid MusicXML/);
    expect(() => parseMusicXml('<score-partwise version="4.0"></score-partwise>')).toThrow(/no <part>/);

    const badDivisions = SAMPLE_MUSICXML.replace('<divisions>2</divisions>', '<divisions>0</divisions>');
    expect(() => parseMusicXml(badDivisions)).toThrow(/divisions/i);

    const badPitch = SAMPLE_MUSICXML.replace(
      '<pitch><step>C</step><octave>4</octave></pitch>',
      '<pitch><step>H</step><octave>4</octave></pitch>',
    );
    expect(() => parseMusicXml(badPitch)).toThrow(/pitch step/i);

    const zeroDuration = SAMPLE_MUSICXML.replace('<duration>2</duration>', '<duration>0</duration>');
    expect(() => parseMusicXml(zeroDuration)).toThrow(/duration/i);
  });

  it('does not hang or allocate unboundedly on many empty measures', () => {
    const measures = '<measure number="1"/>'.repeat(60);
    const xml = `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Empty</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
    const score = parseMusicXml(xml);
    expect(score.notes).toHaveLength(0);
    expect(score.lengthBeats).toBe(0);
  });
});

describe('writeMusicXml', () => {
  const score: Score = createScore({
    title: 'Roundtrip "Test" & <Friends>',
    composer: 'A. Composer',
    notes: [
      { id: 'r1', midi: 60, start: 0, duration: 1, velocity: 80, hand: 'right' },
      { id: 'r2', midi: 64, start: 0, duration: 1, velocity: 80, hand: 'right' },
      { id: 'r3', midi: 67, start: 0, duration: 0.5, velocity: 80, hand: 'right' },
      { id: 'r4', midi: 62, start: 1.5, duration: 3, velocity: 80, hand: 'right' },
      { id: 'r5', midi: 69, start: 2, duration: 2, velocity: 80, hand: 'right' },
      { id: 'l1', midi: 48, start: 0, duration: 2, velocity: 80, hand: 'left' },
      { id: 'l2', midi: 43, start: 2, duration: 2, velocity: 80, hand: 'left' },
    ],
    tempo: [
      { beat: 0, bpm: 100 },
      { beat: 6, bpm: 60 },
    ],
    timeSignatures: [
      { beat: 0, numerator: 4, denominator: 4 },
      { beat: 8, numerator: 3, denominator: 4 },
    ],
    keySignature: { fifths: -3, mode: 'minor' },
    ppq: 480,
    source: 'musicxml',
    lengthBeats: 11,
  });

  it('produces regular MusicXML with divisions, ties, backups, offset tempo and escaped text', () => {
    const xml = writeMusicXml(score);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<!DOCTYPE score-partwise');
    expect(xml).toContain('<divisions>480</divisions>');
    expect(xml).toContain('<tie type="start"/>'); // r4 crosses the bar line
    expect(xml).toContain('<backup>'); // overlapping right-hand voice
    expect(xml).toContain('<offset>960</offset>'); // tempo change mid-measure
    expect(xml).toContain('&amp;'); // title escaping
    expect(xml).toContain('&lt;Friends&gt;');
    expect(xml).not.toContain('<Friends>');
    expect(xml).toContain('<time><beats>3</beats><beat-type>4</beat-type></time>'); // signature change
  });

  it('roundtrips notes, hands, tempo, signatures, key and metadata', () => {
    const reparsed = parseMusicXml(writeMusicXml(score));

    expect(reparsed.notes).toHaveLength(score.notes.length);
    for (const original of score.notes) {
      const match = reparsed.notes.find(
        (candidate) => candidate.midi === original.midi && candidate.hand === original.hand,
      );
      expect(match, `missing note ${original.hand}:${original.midi}`).toBeDefined();
      if (!match) continue;
      expect(match.start).toBeCloseTo(original.start, 6);
      expect(match.duration).toBeCloseTo(original.duration, 6);
    }

    expect(reparsed.title).toBe(score.title);
    expect(reparsed.composer).toBe(score.composer);
    expect(reparsed.keySignature).toEqual(score.keySignature);
    expect(reparsed.ppq).toBe(480);

    expect(reparsed.tempo).toHaveLength(2);
    expect(reparsed.tempo[0].beat).toBeCloseTo(0, 9);
    expect(reparsed.tempo[0].bpm).toBeCloseTo(100, 9);
    expect(reparsed.tempo[1].beat).toBeCloseTo(6, 9);
    expect(reparsed.tempo[1].bpm).toBeCloseTo(60, 9);

    expect(reparsed.timeSignatures).toHaveLength(2);
    expect(reparsed.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
    expect(reparsed.timeSignatures[1].beat).toBeCloseTo(8, 9);
    expect(reparsed.timeSignatures[1]).toMatchObject({ numerator: 3, denominator: 4 });
  });

  it('roundtrips sixteenth-note quantization grids exactly', () => {
    const sixteenths = createScore({
      title: 'Sixteenths',
      notes: [
        { id: 'a', midi: 60, start: 0, duration: 0.25, velocity: 90, hand: 'right' },
        { id: 'b', midi: 62, start: 0.25, duration: 0.5, velocity: 90, hand: 'right' },
        { id: 'c', midi: 64, start: 0.75, duration: 0.25, velocity: 90, hand: 'right' },
        { id: 'd', midi: 65, start: 1, duration: 0.25, velocity: 90, hand: 'right' },
      ],
      lengthBeats: 4,
    });
    const reparsed = parseMusicXml(writeMusicXml(sixteenths));
    expect(reparsed.notes).toHaveLength(4);
    for (const original of sixteenths.notes) {
      const match = reparsed.notes.find((candidate) => candidate.midi === original.midi);
      expect(match).toBeDefined();
      expect(match?.start).toBeCloseTo(original.start, 8);
      expect(match?.duration).toBeCloseTo(original.duration, 8);
    }
  });
});
