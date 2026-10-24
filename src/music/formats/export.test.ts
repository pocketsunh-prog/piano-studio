import { describe, expect, it } from 'vitest';
import { DEMO_SONGS } from '../demo';
import { createScore } from '../score';
import type { NoteEvent, Score } from '../types';
import { buildExport, scoreFromJson, scoreToJson } from './export';
import { parseMidi, writeMidi } from './midi';
import { parseMusicXml, writeMusicXml } from './musicxml';
import { toArrayBuffer } from './testkit';

const sample: Score = createScore({
  title: 'My Song / Test',
  composer: 'Composer X',
  notes: [
    { id: 'a', midi: 60, start: 0, duration: 1, velocity: 90, hand: 'right', track: 0, voice: 1 },
    { id: 'b', midi: 48, start: 0.5, duration: 1.5, velocity: 70, hand: 'left', track: 1 },
    { id: 'c', midi: 72, start: 3, duration: 0.5, velocity: 100, hand: 'right' },
  ],
  tempo: [{ beat: 0, bpm: 104 }],
  timeSignatures: [{ beat: 0, numerator: 6, denominator: 8 }],
  keySignature: { fifths: 2, mode: 'major' },
  ppq: 480,
  source: 'musicxml',
  lengthBeats: 8,
});

describe('buildExport', () => {
  it('exports MusicXML that our own parser can read back', () => {
    const exported = buildExport(sample, 'musicxml');
    expect(exported.fileName).toBe('My Song Test.musicxml');
    expect(exported.mime).toBe('application/vnd.recordare.musicxml+xml');
    expect(typeof exported.data).toBe('string');
    const reparsed = parseMusicXml(exported.data as string);
    expect(reparsed.notes).toHaveLength(sample.notes.length);
    for (const original of sample.notes) {
      const match = reparsed.notes.find(
        (candidate) => candidate.midi === original.midi && candidate.hand === original.hand,
      );
      expect(match).toBeDefined();
      expect(match?.start).toBeCloseTo(original.start, 6);
      expect(match?.duration).toBeCloseTo(original.duration, 6);
    }
    expect(reparsed.title).toBe(sample.title);
    expect(reparsed.composer).toBe(sample.composer);
  });

  it('exports a valid MIDI file that our own parser can read back', () => {
    const exported = buildExport(sample, 'midi');
    expect(exported.fileName).toBe('My Song Test.mid');
    expect(exported.mime).toBe('audio/midi');
    expect(exported.data).toBeInstanceOf(Uint8Array);
    const bytes = exported.data as Uint8Array;
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64]);
    const reparsed = parseMidi(toArrayBuffer(bytes));
    expect(reparsed.notes).toHaveLength(sample.notes.length);
    expect(reparsed.tempo[0].bpm).toBeCloseTo(104, 5);
    for (const original of sample.notes) {
      const match = reparsed.notes.find(
        (candidate) => candidate.midi === original.midi && candidate.hand === original.hand,
      );
      expect(match).toBeDefined();
      expect(match?.start).toBeCloseTo(original.start, 6);
      expect(match?.duration).toBeCloseTo(original.duration, 6);
    }
  });

  it('exports JSON and roundtrips every field we keep', () => {
    const exported = buildExport(sample, 'json');
    expect(exported.fileName).toBe('My Song Test.json');
    expect(exported.mime).toBe('application/json');
    expect(typeof exported.data).toBe('string');
    const reparsed = scoreFromJson(exported.data as string);
    expect(reparsed.title).toBe(sample.title);
    expect(reparsed.composer).toBe(sample.composer);
    expect(reparsed.source).toBe('musicxml');
    expect(reparsed.ppq).toBe(480);
    expect(reparsed.keySignature).toEqual({ fifths: 2, mode: 'major' });
    expect(reparsed.tempo[0].bpm).toBeCloseTo(104, 9);
    expect(reparsed.timeSignatures[0]).toMatchObject({ numerator: 6, denominator: 8 });
    expect(reparsed.notes).toHaveLength(3);
    const original = sample.notes.find((note) => note.id === 'a');
    const restored = reparsed.notes.find((note) => note.midi === 60);
    expect(restored).toMatchObject({
      start: original?.start,
      duration: original?.duration,
      velocity: original?.velocity,
      hand: original?.hand,
      track: original?.track,
      voice: original?.voice,
    });
  });

  it('sanitises file names and rejects unknown formats', () => {
    const untitled = createScore({ title: '' });
    expect(buildExport(untitled, 'json').fileName).toBe('score.json');
    const illegal = createScore({ title: 'Bad/Name: "quoted"? <x>|*' });
    const exported = buildExport(illegal, 'json');
    expect(exported.fileName).not.toMatch(/[\\/:*?"<>|]/);
    expect(exported.fileName.endsWith('.json')).toBe(true);
    expect(() => buildExport(sample, 'pdf' as never)).toThrow(/Unsupported export format/);
  });
});

describe('built-in demo songs', () => {
  function multiset(notes: NoteEvent[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const note of notes) {
      const key = [
        note.hand,
        note.midi,
        Math.round(note.start * 1e6),
        Math.round(note.duration * 1e6),
      ].join('|');
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  it('roundtrips every DEMO_SONGS score through MusicXML, MIDI and JSON', () => {
    expect(DEMO_SONGS.length).toBeGreaterThan(0);
    for (const song of DEMO_SONGS) {
      const xmlCopy = parseMusicXml(writeMusicXml(song));
      expect(multiset(xmlCopy.notes), `MusicXML roundtrip: ${song.title}`).toEqual(
        multiset(song.notes),
      );

      const midiCopy = parseMidi(toArrayBuffer(writeMidi(song)));
      expect(multiset(midiCopy.notes), `MIDI roundtrip: ${song.title}`).toEqual(
        multiset(song.notes),
      );

      const jsonCopy = scoreFromJson(scoreToJson(song));
      expect(multiset(jsonCopy.notes), `JSON roundtrip: ${song.title}`).toEqual(
        multiset(song.notes),
      );
      expect(jsonCopy.title).toBe(song.title);
    }
  });
});

describe('scoreToJson / scoreFromJson', () => {
  it('rejects malformed JSON and hostile values with clear errors', () => {
    expect(() => scoreFromJson('')).toThrow(/empty/i);
    expect(() => scoreFromJson('not json')).toThrow(/valid JSON/i);
    expect(() => scoreFromJson('42')).toThrow(/object/i);
    expect(() => scoreFromJson('null')).toThrow(/object/i);
    expect(() => scoreFromJson('{}')).toThrow(/notes/i);
    expect(() =>
      scoreFromJson(JSON.stringify({ notes: [{ midi: '60', start: 0, duration: 1 }] })),
    ).toThrow(/midi/i);
    expect(() =>
      scoreFromJson(JSON.stringify({ notes: [{ midi: 60, start: 0, duration: 1 }], tempo: {} })),
    ).toThrow(/tempo/i);
    expect(() =>
      scoreFromJson(JSON.stringify({ notes: [{ midi: 60, start: 0, duration: 1 }], source: 5 })),
    ).not.toThrow();
  });

  it('accepts a bare score object (without the version wrapper)', () => {
    const bare = scoreToJson(sample);
    const wrapped = JSON.parse(bare) as { score: unknown };
    const reparsed = scoreFromJson(JSON.stringify(wrapped.score));
    expect(reparsed.notes).toHaveLength(3);
    expect(reparsed.title).toBe('My Song / Test');
  });

  it('clamps values through the shared score model instead of trusting input', () => {
    const reparsed = scoreFromJson(
      JSON.stringify({
        title: 'Clamped',
        notes: [
          { midi: 200, start: -4, duration: 0.0001, velocity: 500, hand: 'left' },
          { midi: 60, start: 2, duration: 0.5 },
        ],
        tempo: [{ beat: 0, bpm: 0 }],
      }),
    );
    expect(reparsed.notes).toHaveLength(2);
    expect(reparsed.notes[0].midi).toBeLessThanOrEqual(108);
    expect(reparsed.notes[0].start).toBeGreaterThanOrEqual(0);
    expect(reparsed.notes[0].duration).toBeGreaterThan(0);
    expect(reparsed.notes[0].velocity).toBeLessThanOrEqual(127);
    expect(reparsed.notes[0].hand).toBe('left');
    expect(reparsed.notes[1].hand).toBe('right'); // derived from pitch
    expect(reparsed.tempo[0].bpm).toBeGreaterThan(0);
  });
});
