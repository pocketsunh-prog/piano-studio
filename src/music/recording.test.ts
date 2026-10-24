import { describe, expect, it } from 'vitest';
import { recordingToScore } from './recording';
import type { RecordedNote } from '../hooks/useRecorder';

describe('recordingToScore', () => {
  it('quantizes recorded milliseconds into beats at 120 bpm', () => {
    const recorded: RecordedNote[] = [
      { midi: 60, velocity: 90, startMs: 0, endMs: 500 },
      { midi: 64, velocity: 80, startMs: 500, endMs: 1000 },
      { midi: 67, velocity: 100, startMs: 125, endMs: 360 },
    ];
    const score = recordingToScore(recorded, 'Take 1');
    expect(score.title).toBe('Take 1');
    expect(score.source).toBe('recording');
    expect(score.tempo[0].bpm).toBe(120);
    const byMidi = new Map(score.notes.map((note) => [note.midi, note]));
    expect(byMidi.get(60)?.start).toBe(0);
    expect(byMidi.get(60)?.duration).toBe(1);
    expect(byMidi.get(64)?.start).toBe(1);
    expect(byMidi.get(67)?.start).toBe(0.25);
    expect(byMidi.get(67)?.duration).toBe(0.5);
  });

  it('assigns hands by pitch and pads the length to whole bars', () => {
    const score = recordingToScore([
      { midi: 48, velocity: 70, startMs: 0, endMs: 600 },
      { midi: 72, velocity: 90, startMs: 1000, endMs: 1400 },
    ]);
    expect(score.notes.find((note) => note.midi === 48)?.hand).toBe('left');
    expect(score.notes.find((note) => note.midi === 72)?.hand).toBe('right');
    expect(score.lengthBeats % 4).toBe(0);
    expect(score.lengthBeats).toBeGreaterThanOrEqual(4);
  });

  it('ignores empty or invalid recordings', () => {
    expect(recordingToScore([]).notes).toHaveLength(0);
    expect(
      recordingToScore([{ midi: 60, velocity: 80, startMs: 500, endMs: 400 }]).notes,
    ).toHaveLength(0);
  });
});
