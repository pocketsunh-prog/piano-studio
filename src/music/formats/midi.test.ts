import { describe, expect, it } from 'vitest';
import { createScore } from '../score';
import type { NoteEvent, Score } from '../types';
import { parseMidi, writeMidi } from './midi';

/* ---------------------------------------------------------------- */
/* A tiny Standard MIDI File builder for the hand-crafted fixtures.   */
/* ---------------------------------------------------------------- */

interface RawEvent {
  delta: number;
  bytes: number[];
}

function vlq(value: number): number[] {
  let n = Math.max(0, Math.floor(value));
  const out = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return out;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function metaText(type: number, text: string): number[] {
  const payload = Array.from(new TextEncoder().encode(text));
  return [0xff, type, ...vlq(payload.length), ...payload];
}

function trackChunk(body: number[]): number[] {
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
}

function buildTrack(events: RawEvent[]): number[] {
  const body: number[] = [];
  for (const event of events) body.push(...vlq(event.delta), ...event.bytes);
  body.push(0x00, 0xff, 0x2f, 0x00);
  return trackChunk(body);
}

function buildMidi(ppq: number, tracks: number[][], format = 1): ArrayBuffer {
  const header = [
    0x4d,
    0x54,
    0x68,
    0x64,
    ...u32(6),
    0x00,
    format,
    (tracks.length >>> 8) & 0xff,
    tracks.length & 0xff,
    (ppq >>> 8) & 0xff,
    ppq & 0xff,
  ];
  const all = [...header, ...tracks.flat()];
  const bytes = new Uint8Array(all);
  return bytes.buffer as ArrayBuffer;
}

function bytesOf(score: Score): Uint8Array {
  return writeMidi(score);
}

const RIGHT_HAND = 'right';
const LEFT_HAND = 'left';

function roundtripCounts(score: Score): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const note of score.notes) {
    const key = `${note.hand}:${note.midi}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe('parseMidi', () => {
  it('reads tempo, time/key signature, running status, SysEx and two-track hands', () => {
    const tempoTrack = buildTrack([
      { delta: 0, bytes: metaText(0x03, 'Test Song') },
      { delta: 0, bytes: [0xff, 0x51, 0x03, 0x09, 0x27, 0xc0] }, // 600000us = 100 bpm
      { delta: 0, bytes: [0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08] }, // 3/4
      { delta: 0, bytes: [0xff, 0x59, 0x02, 0x02, 0x00] }, // 2 sharps, major
      { delta: 0, bytes: [0xf0, 0x03, 0x7e, 0x7f, 0x09] }, // SysEx, to be skipped
    ]);
    const rightTrack = buildTrack([
      { delta: 0, bytes: metaText(0x03, 'Piano 1') },
      { delta: 0, bytes: [0x90, 60, 100] }, // C4 on
      { delta: 0, bytes: [64, 100] }, // E4 on via running status
      { delta: 0, bytes: [67, 100] }, // G4 on via running status
      { delta: 480, bytes: [0x80, 60, 64] },
      { delta: 0, bytes: [64, 64] },
      { delta: 0, bytes: [67, 64] },
      { delta: 0, bytes: [0x90, 72, 90] }, // C5 on, next beat
      { delta: 480, bytes: [0x80, 72, 64] },
    ]);
    const leftTrack = buildTrack([
      { delta: 0, bytes: metaText(0x03, 'Piano 2') },
      { delta: 0, bytes: [0x90, 48, 80] }, // C3 on
      { delta: 960, bytes: [0x80, 48, 64] }, // two beats
      { delta: 0, bytes: [0x90, 55, 80] }, // G3 on
      { delta: 480, bytes: [0x80, 55, 64] },
    ]);

    const score = parseMidi(buildMidi(480, [tempoTrack, rightTrack, leftTrack]));

    expect(score.notes).toHaveLength(6);
    expect(score.title).toBe('Test Song');
    expect(score.ppq).toBe(480);
    expect(score.source).toBe('midi');
    expect(score.tempo).toHaveLength(1);
    expect(score.tempo[0].bpm).toBeCloseTo(100, 6);
    expect(score.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
    expect(score.keySignature).toEqual({ fifths: 2, mode: 'major' });

    const c4 = score.notes.find((note) => note.midi === 60);
    expect(c4).toBeDefined();
    expect(c4?.hand).toBe(RIGHT_HAND);
    expect(c4?.start).toBeCloseTo(0, 9);
    expect(c4?.duration).toBeCloseTo(1, 9);
    expect(c4?.velocity).toBe(100);
    expect(c4?.track).toBe(1);

    const c5 = score.notes.find((note) => note.midi === 72);
    expect(c5?.start).toBeCloseTo(1, 9);
    expect(c5?.hand).toBe(RIGHT_HAND);

    const c3 = score.notes.find((note) => note.midi === 48);
    expect(c3?.hand).toBe(LEFT_HAND);
    expect(c3?.duration).toBeCloseTo(2, 9);
    expect(c3?.velocity).toBe(80);

    const g3 = score.notes.find((note) => note.midi === 55);
    expect(g3?.hand).toBe(LEFT_HAND);
    expect(g3?.start).toBeCloseTo(2, 9);
  });

  it('treats note-on with velocity 0 as note-off and derives hands from channels', () => {
    const track = buildTrack([
      { delta: 0, bytes: [0x90, 64, 90] }, // channel 0, high
      { delta: 0, bytes: [0x91, 48, 90] }, // channel 1, low
      { delta: 480, bytes: [0x80, 64, 64] },
      { delta: 0, bytes: [0x81, 48, 64] },
      { delta: 0, bytes: [0x90, 67, 90] }, // channel 0
      { delta: 480, bytes: [0x90, 67, 0] }, // velocity-0 note-on = note-off
    ]);
    const score = parseMidi(buildMidi(480, [track], 0));

    expect(score.notes).toHaveLength(3);
    expect(score.notes.find((note) => note.midi === 64)?.hand).toBe(RIGHT_HAND);
    expect(score.notes.find((note) => note.midi === 48)?.hand).toBe(LEFT_HAND);
    const g4 = score.notes.find((note) => note.midi === 67);
    expect(g4?.duration).toBeCloseTo(1, 9);
  });

  it('falls back to a pitch split when a MIDI file has one channel and one track', () => {
    const track = buildTrack([
      { delta: 0, bytes: [0x90, 72, 80] },
      { delta: 0, bytes: [0x90, 45, 80] },
      { delta: 480, bytes: [0x80, 72, 64] },
      { delta: 0, bytes: [0x80, 45, 64] },
    ]);
    const score = parseMidi(buildMidi(480, [track], 0));
    expect(score.notes.find((note) => note.midi === 72)?.hand).toBe(RIGHT_HAND);
    expect(score.notes.find((note) => note.midi === 45)?.hand).toBe(LEFT_HAND);
  });

  it('rejects empty, truncated and non-MIDI input', () => {
    expect(() => parseMidi(new ArrayBuffer(0))).toThrow(/empty/i);
    expect(() => parseMidi(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer)).toThrow(/too short/i);

    const notMidi = new Uint8Array(14);
    notMidi.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    expect(() => parseMidi(notMidi.buffer as ArrayBuffer)).toThrow(/Standard MIDI File/);

    // Header promises a track but no track chunk follows.
    const headerOnly = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0,
    ]);
    expect(() => parseMidi(headerOnly.buffer as ArrayBuffer)).toThrow(/missing track chunk/i);

    // Track chunk declares 100 bytes but the file ends.
    const truncated = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 100, 0x00, 0x90, 60, 100,
    ]);
    expect(() => parseMidi(truncated.buffer as ArrayBuffer)).toThrow(/truncated/i);

    // SMPTE timing.
    const smpte = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0xe7, 0x28,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0x00, 0xff, 0x2f, 0x00,
    ]);
    expect(() => parseMidi(smpte.buffer as ArrayBuffer)).toThrow(/SMPTE/);

    // Data byte without a status byte.
    const noStatus = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0,
      ...trackChunk([0x00, 0x40]),
    ]);
    expect(() => parseMidi(noStatus.buffer as ArrayBuffer)).toThrow(/status byte/i);
  });
});

describe('writeMidi', () => {
  it('writes a format-1 file with tempo/time-signature events and roundtrips notes', () => {
    const notes: NoteEvent[] = [
      { id: 'n1', midi: 60, start: 0, duration: 1, velocity: 90, hand: RIGHT_HAND },
      { id: 'n2', midi: 64, start: 0, duration: 1, velocity: 80, hand: RIGHT_HAND },
      { id: 'n3', midi: 67, start: 0, duration: 1, velocity: 80, hand: RIGHT_HAND },
      { id: 'n4', midi: 72, start: 1.5, duration: 0.5, velocity: 70, hand: RIGHT_HAND },
      { id: 'n5', midi: 48, start: 0, duration: 2, velocity: 60, hand: LEFT_HAND },
      { id: 'n6', midi: 43, start: 2, duration: 2, velocity: 50, hand: LEFT_HAND },
    ];
    const score = createScore({
      title: 'MIDI Roundtrip',
      composer: 'Sheet IO',
      notes,
      tempo: [
        { beat: 0, bpm: 90 },
        { beat: 4, bpm: 120 },
      ],
      timeSignatures: [{ beat: 0, numerator: 3, denominator: 4 }],
      keySignature: { fifths: -3, mode: 'minor' },
      ppq: 480,
      source: 'midi',
      lengthBeats: 4,
    });

    const bytes = bytesOf(score);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64]);
    expect([bytes[8], bytes[9]]).toEqual([0x00, 0x01]); // format 1
    expect((bytes[12] << 8) | bytes[13]).toBe(480); // division
    const contains = (pattern: number[]): boolean => {
      for (let i = 0; i + pattern.length <= bytes.length; i += 1) {
        if (pattern.every((value, offset) => bytes[i + offset] === value)) return true;
      }
      return false;
    };
    expect(contains([0xff, 0x51])).toBe(true); // tempo meta
    expect(contains([0xff, 0x58])).toBe(true); // time-signature meta
    expect(contains([0xff, 0x59])).toBe(true); // key-signature meta

    const reparsed = parseMidi(bytes.buffer as ArrayBuffer);
    expect(reparsed.title).toBe('MIDI Roundtrip');
    expect(reparsed.composer).toBe('Sheet IO');
    expect(reparsed.ppq).toBe(480);
    expect(reparsed.notes).toHaveLength(score.notes.length);
    for (const original of score.notes) {
      const match = reparsed.notes.find(
        (candidate) => candidate.midi === original.midi && candidate.hand === original.hand,
      );
      expect(match, `missing note ${original.hand}:${original.midi}`).toBeDefined();
      if (!match) continue;
      expect(match.start).toBeCloseTo(original.start, 6);
      expect(match.duration).toBeCloseTo(original.duration, 6);
      expect(match.velocity).toBe(original.velocity);
    }
    expect(reparsed.tempo.map((event) => event.beat)).toEqual([0, 4]);
    expect(reparsed.tempo[0].bpm).toBeCloseTo(90, 5);
    expect(reparsed.tempo[1].bpm).toBeCloseTo(120, 5);
    expect(reparsed.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
    expect(reparsed.keySignature).toEqual({ fifths: -3, mode: 'minor' });
  });

  it('roundtrips a score without notes as a valid file and keeps its metadata', () => {
    const score = createScore({ title: 'Silence', tempo: [{ beat: 0, bpm: 66 }] });
    const bytes = bytesOf(score);
    const reparsed = parseMidi(bytes.buffer as ArrayBuffer);
    expect(reparsed.title).toBe('Silence');
    expect(reparsed.notes).toHaveLength(0);
    expect(reparsed.tempo[0].bpm).toBeCloseTo(66, 5);
  });

  it('output is deterministic for the same input (handy for export tests)', () => {
    const score = createScore({
      title: 'Deterministic',
      notes: [{ id: 'a', midi: 61, start: 0.5, duration: 0.5, velocity: 88, hand: RIGHT_HAND }],
    });
    const first = bytesOf(score);
    const second = bytesOf(score);
    expect(Array.from(first)).toEqual(Array.from(second));
    expect(roundtripCounts(parseMidi(first.buffer as ArrayBuffer))).toEqual({ 'right:61': 1 });
  });
});
