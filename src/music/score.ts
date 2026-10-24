import type {
  Hand,
  KeySignature,
  NoteEvent,
  Score,
  ScoreSource,
  TempoEvent,
  TimeSignatureEvent,
} from './types';
import { DEFAULT_KEY_SIGNATURE, DEFAULT_PPQ, DEFAULT_TEMPO } from './types';
import { clampMidi } from './timing';

export interface ScoreInit {
  id?: string;
  title?: string;
  composer?: string;
  notes?: NoteEvent[];
  tempo?: TempoEvent[];
  timeSignatures?: TimeSignatureEvent[];
  keySignature?: KeySignature;
  ppq?: number;
  source?: ScoreSource;
  lengthBeats?: number;
}

export function notesEndBeat(notes: readonly NoteEvent[]): number {
  let end = 0;
  for (const note of notes) end = Math.max(end, note.start + note.duration);
  return end;
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}-${i}`)) i += 1;
  const id = `${base}-${i}`;
  used.add(id);
  return id;
}

/**
 * Validates and copies a score: sorts notes by onset, clamps pitches/durations,
 * guarantees unique ids, tempo/time-signature events at beat 0, and a
 * `lengthBeats` that covers every note.
 */
export function normalizeScore(score: Score): Score {
  const used = new Set<string>();
  const notes = score.notes
    .filter((note) => Number.isFinite(note.start) && Number.isFinite(note.duration) && note.duration > 0)
    .map((note) => {
      const start = Math.max(0, note.start);
      return {
        ...note,
        id: uniqueId(note.id || `n-${note.start}-${note.midi}`, used),
        midi: clampMidi(note.midi),
        start,
        duration: Math.max(0.001, note.duration),
        velocity: Math.min(127, Math.max(1, Math.round(note.velocity || 80))),
        hand: (note.hand === 'left' ? 'left' : 'right') as Hand,
      };
    })
    .sort((a, b) => a.start - b.start || a.midi - b.midi);

  const tempo = (score.tempo.length ? score.tempo : [{ beat: 0, bpm: DEFAULT_TEMPO }])
    .map((event) => ({ beat: Math.max(0, event.beat), bpm: Math.max(20, event.bpm || DEFAULT_TEMPO) }))
    .sort((a, b) => a.beat - b.beat);
  tempo[0] = { ...tempo[0], beat: 0 };

  const timeSignatures = (score.timeSignatures.length
    ? score.timeSignatures
    : [{ beat: 0, numerator: 4, denominator: 4 }]
  )
    .map((event) => ({
      beat: Math.max(0, event.beat),
      numerator: Math.max(1, Math.round(event.numerator || 4)),
      denominator: Math.max(1, Math.round(event.denominator || 4)),
    }))
    .sort((a, b) => a.beat - b.beat);
  timeSignatures[0] = { ...timeSignatures[0], beat: 0 };

  const end = notesEndBeat(notes);
  return {
    ...score,
    notes,
    tempo,
    timeSignatures,
    keySignature: score.keySignature ?? DEFAULT_KEY_SIGNATURE,
    ppq: score.ppq || DEFAULT_PPQ,
    lengthBeats: Math.max(score.lengthBeats || 0, end),
  };
}

export function createScore(init: ScoreInit): Score {
  return normalizeScore({
    id: init.id ?? `score-${Math.random().toString(36).slice(2, 9)}`,
    title: init.title ?? 'Untitled',
    composer: init.composer ?? '',
    notes: init.notes ?? [],
    tempo: init.tempo ?? [{ beat: 0, bpm: DEFAULT_TEMPO }],
    timeSignatures: init.timeSignatures ?? [{ beat: 0, numerator: 4, denominator: 4 }],
    keySignature: init.keySignature ?? DEFAULT_KEY_SIGNATURE,
    ppq: init.ppq ?? DEFAULT_PPQ,
    source: init.source ?? 'recording',
    lengthBeats: init.lengthBeats ?? 0,
  });
}

/** Transposes every note by `semitones`, dropping notes outside the piano range. */
export function transposeScore(score: Score, semitones: number): Score {
  const notes = score.notes
    .map((note) => ({ ...note, midi: note.midi + semitones }))
    .filter((note) => note.midi >= 0 && note.midi <= 127);
  return normalizeScore({
    ...score,
    id: `${score.id}-t${semitones}`,
    notes,
    lengthBeats: notesEndBeat(notes),
  });
}

/** Extract the notes inside [fromBeat, toBeat) and rebase them to beat 0. */
export function subsetScore(score: Score, fromBeat: number, toBeat: number): Score {
  const notes = score.notes
    .filter((note) => note.start >= fromBeat && note.start < toBeat)
    .map((note) => ({ ...note, start: note.start - fromBeat }));
  return normalizeScore({
    ...score,
    id: `${score.id}-part-${fromBeat}`,
    notes,
    lengthBeats: toBeat - fromBeat,
  });
}
