import type { RecordedNote } from '../hooks/useRecorder';
import type { NoteEvent, Score } from './types';
import { createScore } from './score';

const DEFAULT_BPM = 120;
const GRID = 0.25; // sixteenth note

/**
 * Converts raw recorded note timings into a quantized 4/4 Score at 120 BPM.
 * Recording is intentionally simple: it captures free playing at a fixed tempo.
 */
export function recordingToScore(notes: readonly RecordedNote[], title = 'My Recording'): Score {
  const beatsPerSecond = DEFAULT_BPM / 60;
  const snap = (value: number): number => Math.round(value / GRID) * GRID;

  const events: NoteEvent[] = notes
    .filter((note) => note.endMs > note.startMs)
    .map((note, index): NoteEvent => {
      const start = snap((note.startMs / 1000) * beatsPerSecond);
      const rawDuration = ((note.endMs - note.startMs) / 1000) * beatsPerSecond;
      return {
        id: `rec-${index}`,
        midi: note.midi,
        start: Math.max(0, start),
        duration: Math.max(GRID, snap(rawDuration)),
        velocity: Math.max(1, Math.min(127, Math.round(note.velocity))),
        hand: note.midi < 60 ? 'left' : 'right',
        track: note.midi < 60 ? 1 : 0,
      };
    })
    .sort((a, b) => a.start - b.start || a.midi - b.midi);

  const end = events.reduce((max, note) => Math.max(max, note.start + note.duration), 0);
  const lengthBeats = Math.max(4, Math.ceil(end / 4) * 4);

  return createScore({
    title,
    composer: 'You',
    notes: events,
    tempo: [{ beat: 0, bpm: DEFAULT_BPM }],
    timeSignatures: [{ beat: 0, numerator: 4, denominator: 4 }],
    keySignature: { fifths: 0, mode: 'major' },
    source: 'recording',
    lengthBeats,
  });
}
