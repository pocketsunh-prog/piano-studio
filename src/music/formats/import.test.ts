import { describe, expect, it } from 'vitest';
import { createScore } from '../score';
import { parseScoreFile } from './import';
import { writeMidi } from './midi';
import {
  CONTAINER_XML,
  makeZip,
  MINIMAL_MUSICXML,
  SAMPLE_MUSICXML,
  toArrayBuffer,
} from './testkit';

function xmlBuffer(xml: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(xml));
}

describe('parseScoreFile', () => {
  it('imports an uncompressed .musicxml file', async () => {
    const score = await parseScoreFile('study.musicxml', xmlBuffer(SAMPLE_MUSICXML));
    expect(score.notes).toHaveLength(11);
    expect(score.title).toBe('Tie & Chord Study');
    expect(score.composer).toBe('Test Composer');
  });

  it('imports a .xml file and falls back to a title derived from the file name', async () => {
    const score = await parseScoreFile('Moonlight Sonata.xml', xmlBuffer(MINIMAL_MUSICXML));
    expect(score.title).toBe('Moonlight Sonata');
    expect(score.notes).toHaveLength(1);
    expect(score.notes[0].midi).toBe(69);
  });

  it('imports a compressed .mxl archive using META-INF/container.xml', async () => {
    const archive = makeZip({
      'META-INF/container.xml': CONTAINER_XML,
      'score.musicxml': SAMPLE_MUSICXML,
      'readme.txt': 'ignored',
    });
    const score = await parseScoreFile('compressed.mxl', archive);
    expect(score.notes).toHaveLength(11);
    expect(score.title).toBe('Tie & Chord Study');
  });

  it('imports a .mxl archive without a container by finding the first score XML', async () => {
    const archive = makeZip({ 'scores/untitled.musicxml': MINIMAL_MUSICXML });
    const score = await parseScoreFile('no-container.mxl', archive);
    expect(score.notes).toHaveLength(1);
  });

  it('imports .mid files through writeMidi', async () => {
    const original = createScore({
      title: 'Midi File Import',
      notes: [
        { id: 'a', midi: 60, start: 0, duration: 1, velocity: 100, hand: 'right' },
        { id: 'b', midi: 48, start: 0, duration: 2, velocity: 70, hand: 'left' },
      ],
      tempo: [{ beat: 0, bpm: 105 }],
    });
    const bytes = writeMidi(original);
    const score = await parseScoreFile('midi-file.mid', bytes.buffer as ArrayBuffer);
    expect(score.title).toBe('Midi File Import');
    expect(score.notes).toHaveLength(2);
    expect(score.tempo[0].bpm).toBeCloseTo(105, 5);
  });

  it('rejects unsupported extensions, empty files and malformed archives', async () => {
    await expect(parseScoreFile('score.pdf', xmlBuffer(SAMPLE_MUSICXML))).rejects.toThrow(
      /Unsupported file type/,
    );
    await expect(parseScoreFile('noextension', xmlBuffer(SAMPLE_MUSICXML))).rejects.toThrow(
      /Unsupported file type/,
    );
    await expect(parseScoreFile('empty.mid', new ArrayBuffer(0))).rejects.toThrow(
      /Could not import "empty\.mid"/,
    );
    await expect(parseScoreFile('empty.musicxml', new ArrayBuffer(0))).rejects.toThrow(
      /empty/i,
    );
    await expect(
      parseScoreFile('broken.mxl', toArrayBuffer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))),
    ).rejects.toThrow(/Could not import "broken\.mxl"/);
    await expect(
      parseScoreFile('bad.mid', toArrayBuffer(new Uint8Array(32))),
    ).rejects.toThrow(/Standard MIDI File/);
  });
});
