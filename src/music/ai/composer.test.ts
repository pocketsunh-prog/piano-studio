import { describe, expect, it } from 'vitest';
import {
  AI_DIFFICULTIES,
  AI_MOODS,
  AI_STYLES,
  AI_TIME_SIGNATURES,
  aiKeyName,
  composePianoPiece,
} from './composer';
import { parsePrompt } from './prompt';

describe('composePianoPiece', () => {
  it('is deterministic for the same seed', () => {
    const options = {
      style: 'romantic' as const,
      mood: 'dreamy' as const,
      keyRoot: 9,
      mode: 'minor' as const,
      bars: 16,
      seed: 42,
    };
    const a = composePianoPiece(options);
    const b = composePianoPiece(options);
    expect(a.meta.title).toBe(b.meta.title);
    expect(a.score.notes.map((note) => [note.midi, note.start, note.duration])).toEqual(
      b.score.notes.map((note) => [note.midi, note.start, note.duration]),
    );
  });

  it('produces a complete two-hand score with valid timing', () => {
    const { score, meta } = composePianoPiece({
      style: 'classical',
      mood: 'calm',
      keyRoot: 0,
      mode: 'major',
      bars: 16,
      timeSignature: '4/4',
      seed: 7,
    });
    expect(score.notes.length).toBeGreaterThan(40);
    expect(score.notes.some((note) => note.hand === 'left')).toBe(true);
    expect(score.notes.some((note) => note.hand === 'right')).toBe(true);
    expect(score.lengthBeats).toBe(16 * 4);
    expect(score.keySignature.mode).toBe('major');
    expect(meta.keyName).toBe('C major');
    expect(meta.bars).toBe(16);
    for (const note of score.notes) {
      expect(note.start).toBeGreaterThanOrEqual(0);
      expect(note.duration).toBeGreaterThan(0);
      expect(Number.isFinite(note.start + note.duration)).toBe(true);
      expect(note.start).toBeLessThan(score.lengthBeats + 1e-6);
    }
  });

  it('keeps hands in sensible piano ranges', () => {
    const { score } = composePianoPiece({
      style: 'pop',
      mood: 'happy',
      keyRoot: 4,
      mode: 'major',
      bars: 16,
      seed: 3,
    });
    const left = score.notes.filter((note) => note.hand === 'left');
    const right = score.notes.filter((note) => note.hand === 'right');
    expect(Math.min(...left.map((note) => note.midi))).toBeGreaterThanOrEqual(28);
    expect(Math.max(...left.map((note) => note.midi))).toBeLessThanOrEqual(60);
    expect(Math.min(...right.map((note) => note.midi))).toBeGreaterThanOrEqual(60);
    expect(Math.max(...right.map((note) => note.midi))).toBeLessThanOrEqual(96);
  });

  it('uses the requested meter and tempo', () => {
    const waltz = composePianoPiece({
      style: 'waltz',
      bars: 12,
      timeSignature: '3/4',
      bpm: 90,
      seed: 11,
    });
    expect(waltz.score.lengthBeats).toBe(12 * 3);
    expect(waltz.score.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
    expect(waltz.score.tempo[0].bpm).toBe(90);

    const sixEight = composePianoPiece({
      style: 'ambient',
      bars: 8,
      timeSignature: '6/8',
      seed: 11,
    });
    expect(sixEight.score.lengthBeats).toBe(8 * 3);
    expect(sixEight.score.timeSignatures[0]).toMatchObject({ numerator: 6, denominator: 8 });
  });

  it('adjusts density with difficulty', () => {
    const base = { style: 'classical' as const, bars: 16, keyRoot: 0, seed: 9 };
    const easy = composePianoPiece({ ...base, difficulty: 'easy' });
    const advanced = composePianoPiece({ ...base, difficulty: 'advanced' });
    expect(advanced.score.notes.length).toBeGreaterThan(easy.score.notes.length);
  });

  it('generates every style, mood, meter and difficulty without errors', () => {
    for (const style of AI_STYLES) {
      for (const mood of AI_MOODS) {
        for (const difficulty of AI_DIFFICULTIES) {
          const { score } = composePianoPiece({
            style: style.value,
            mood: mood.value,
            difficulty: difficulty.value,
            timeSignature: '4/4',
            bars: 8,
            seed: 21,
          });
          expect(score.notes.length).toBeGreaterThan(0);
          expect(score.notes.every((note) => note.duration > 0)).toBe(true);
        }
      }
    }
    for (const meter of AI_TIME_SIGNATURES) {
      const { score } = composePianoPiece({ bars: 8, timeSignature: meter.value, seed: 5 });
      expect(score.notes.length).toBeGreaterThan(0);
    }
  });

  it('names common keys correctly', () => {
    expect(aiKeyName(9, 'minor')).toBe('A minor');
    expect(aiKeyName(0, 'major')).toBe('C major');
    expect(aiKeyName(3, 'major')).toBe('Eb major');
    expect(aiKeyName(6, 'major')).toBe('F# major');
    expect(aiKeyName(2, 'minor')).toBe('D minor');
  });

  it('builds title and description metadata', () => {
    const composition = composePianoPiece({
      style: 'jazz',
      mood: 'happy',
      bars: 8,
      seed: 99,
    });
    expect(composition.meta.title).toContain('in ');
    expect(composition.meta.description).toContain('8 bars');
    expect(composition.score.composer).toBe('Piano Studio AI');
    expect(composition.score.title).toBe(composition.meta.title);
  });
});

describe('parsePrompt', () => {
  it('parses style, mood, key, mode, bars and tempo', () => {
    const spec = parsePrompt('dreamy waltz in A minor, 16 bars, 72 bpm, easy');
    expect(spec.style).toBe('waltz');
    expect(spec.mood).toBe('dreamy');
    expect(spec.keyRoot).toBe(9);
    expect(spec.mode).toBe('minor');
    expect(spec.timeSignature).toBe('3/4');
    expect(spec.bars).toBe(16);
    expect(spec.bpm).toBe(72);
    expect(spec.difficulty).toBe('easy');
  });

  it('parses key without a mode and infers from mood', () => {
    const spec = parsePrompt('epic cinematic in D, 24 bars');
    expect(spec.keyRoot).toBe(2);
    expect(spec.mode).toBe('minor');
    expect(spec.style).toBe('classical');
    expect(spec.mood).toBe('epic');
    expect(spec.bars).toBe(24);
  });

  it('parses sharp and flat keys and 6/8 meter', () => {
    expect(parsePrompt('happy pop in F# major, 6/8')).toMatchObject({
      style: 'pop',
      mood: 'happy',
      keyRoot: 6,
      mode: 'major',
      timeSignature: '6/8',
    });
    expect(parsePrompt('calm piece in Bb major').keyRoot).toBe(10);
    expect(parsePrompt('romantic in Eb minor').keyRoot).toBe(3);
  });

  it('returns an empty spec for vague prompts', () => {
    expect(parsePrompt('something nice')).toEqual({});
    expect(parsePrompt('')).toEqual({});
  });
});
