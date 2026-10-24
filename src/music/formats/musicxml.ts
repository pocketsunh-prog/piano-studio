/**
 * MusicXML import/export for Piano Studio.
 *
 * Import supports the `score-partwise` repertoire a piano app needs: multiple
 * parts, divisions, key/time/clef attributes, notes, rests, chords, voices,
 * staves (1 = right hand, 2 = left hand), ties (merged into single notes),
 * backup/forward, tempo from `<sound tempo>` and `<metronome>`, and metadata
 * (`work-title`, `movement-title`, `part-name`, composer creator).
 *
 * Export writes a two-staff piano part. Notes that cross a bar line are split
 * into tied segments so the output stays regular MusicXML; tempo changes that
 * happen away from a measure start are placed with a `<offset>`.
 */
import { createScore, normalizeScore, notesEndBeat } from '../score';
import { measureBeats, timeSignatureAt } from '../timing';
import type { Hand, KeySignature, NoteEvent, Score, TempoEvent, TimeSignatureEvent } from '../types';
import { DEFAULT_KEY_SIGNATURE, DEFAULT_PPQ } from '../types';
import { childText, childrenNamed, escapeXmlText, firstChild, ownText, parseXml } from './xml';
import type { XmlElement } from './xml';

const MAX_NOTES = 50_000;
const MAX_MEASURES = 5_000;
const MAX_PARTS = 64;
const MAX_DIVISIONS = 20_000_000;
const MAX_EXPORT_MEASURES = 2_000;
const MAX_VOICES = 8;

/** Note value (in quarter-note beats) for a MusicXML `<type>` name. */
const TYPE_BEATS: Record<string, number> = {
  maxima: 32,
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  '128th': 0.03125,
  '256th': 0.015625,
};

const STEP_SEMITONES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

interface ParsedNote {
  midi: number;
  start: number;
  duration: number;
  velocity: number;
  staff: number | null;
  voice: number | null;
  part: number;
  tieStart: boolean;
  tieStop: boolean;
}

interface PartResult {
  notes: ParsedNote[];
  tempos: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  key: KeySignature | null;
  divisions: number;
}

function parseInteger(raw: string | null, field: string): number {
  if (raw === null) throw new Error(`MusicXML is missing a required <${field}> element.`);
  const trimmed = raw.trim();
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`MusicXML has an invalid <${field}> value "${trimmed}".`);
  }
  return value;
}

function parsePitch(pitch: XmlElement): number {
  const stepText = childText(pitch, 'step');
  if (!stepText) throw new Error('MusicXML <pitch> is missing a <step> element.');
  const step = stepText.trim().toUpperCase();
  const semitone = STEP_SEMITONES[step];
  if (semitone === undefined) throw new Error(`MusicXML has an invalid pitch step "${stepText}".`);
  const octaveText = childText(pitch, 'octave');
  if (octaveText === null) throw new Error('MusicXML <pitch> is missing an <octave> element.');
  const octave = Number.parseInt(octaveText, 10);
  if (!Number.isFinite(octave) || octave < -1 || octave > 10) {
    throw new Error(`MusicXML has an invalid octave "${octaveText}".`);
  }
  let alter = 0;
  const alterText = childText(pitch, 'alter');
  if (alterText !== null && alterText !== '' && alterText !== '+') {
    const parsedAlter = Number.parseFloat(alterText);
    if (!Number.isFinite(parsedAlter)) {
      throw new Error(`MusicXML has an invalid <alter> value "${alterText}".`);
    }
    alter = Math.round(parsedAlter);
  }
  const midi = (octave + 1) * 12 + semitone + alter;
  if (midi < 0 || midi > 127) {
    throw new Error(`MusicXML pitch is outside the MIDI range (${midi}).`);
  }
  return midi;
}

function readTieInfo(note: XmlElement): { start: boolean; stop: boolean } {
  let start = false;
  let stop = false;
  for (const tie of childrenNamed(note, 'tie')) {
    const type = (tie.attributes.type ?? '').toLowerCase();
    if (type === 'start') start = true;
    else if (type === 'stop') stop = true;
  }
  if (!start && !stop) {
    for (const notations of childrenNamed(note, 'notations')) {
      for (const tied of childrenNamed(notations, 'tied')) {
        const type = (tied.attributes.type ?? '').toLowerCase();
        if (type === 'start') start = true;
        else if (type === 'stop') stop = true;
      }
    }
  }
  return { start, stop };
}

function pushTempo(
  tempos: TempoEvent[],
  beat: number,
  bpm: number,
): void {
  if (!Number.isFinite(bpm) || bpm <= 0) return;
  tempos.push({ beat: Math.max(0, beat), bpm });
}

function parseSoundTempo(
  sound: XmlElement,
  position: number,
  divisions: number,
  tempos: TempoEvent[],
): boolean {
  const tempoAttribute = sound.attributes.tempo;
  if (tempoAttribute === undefined) return false;
  const bpm = Number.parseFloat(tempoAttribute);
  if (!Number.isFinite(bpm) || bpm <= 0) return false;
  pushTempo(tempos, position, bpm);
  return true;
}

function parseDirection(
  direction: XmlElement,
  positionTicks: number,
  divisions: number,
  tempos: TempoEvent[],
): void {
  let offsetTicks = 0;
  const offsetElement = firstChild(direction, 'offset');
  if (offsetElement) {
    const offset = Number.parseInt(ownText(offsetElement), 10);
    if (Number.isFinite(offset)) offsetTicks = offset;
  }
  const position = (positionTicks + offsetTicks) / divisions;

  const sound = firstChild(direction, 'sound');
  if (sound && parseSoundTempo(sound, position, divisions, tempos)) return;

  for (const directionType of childrenNamed(direction, 'direction-type')) {
    const metronome = firstChild(directionType, 'metronome');
    if (!metronome) continue;
    const perMinuteText = childText(metronome, 'per-minute');
    if (perMinuteText === null) continue;
    const perMinute = Number.parseFloat(perMinuteText);
    if (!Number.isFinite(perMinute) || perMinute <= 0) continue;
    const beatUnitText = childText(metronome, 'beat-unit');
    const unitBeats = beatUnitText ? (TYPE_BEATS[beatUnitText.trim().toLowerCase()] ?? 1) : 1;
    let dotsFactor = 1;
    const dots = childrenNamed(metronome, 'beat-unit-dot').length;
    if (dots === 1) dotsFactor = 1.5;
    else if (dots === 2) dotsFactor = 1.75;
    pushTempo(tempos, position, perMinute * unitBeats * dotsFactor);
  }
}

/** Reads `<backup>` / `<forward>` durations in divisions. */
function readMoveDuration(element: XmlElement): number {
  const durationText = childText(element, 'duration');
  if (durationText === null) {
    throw new Error(`MusicXML <${element.name}> is missing a <duration> element.`);
  }
  const duration = Number.parseInt(durationText, 10);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`MusicXML has an invalid <${element.name}> duration "${durationText}".`);
  }
  return duration;
}

function parsePart(part: XmlElement, partIndex: number, noteBudget: { count: number }): PartResult {
  const result: PartResult = {
    notes: [],
    tempos: [],
    timeSignatures: [],
    key: null,
    divisions: 1,
  };
  let divisions = 1;
  let currentNumerator = 4;
  let currentDenominator = 4;
  const measures = childrenNamed(part, 'measure');
  if (measures.length > MAX_MEASURES) {
    throw new Error(`MusicXML part ${partIndex + 1} has too many measures (limit ${MAX_MEASURES}).`);
  }

  let measureStartTicks = 0;
  const tiePending = new Map<string, ParsedNote>();

  for (const measure of measures) {
    let cursorTicks = 0;
    let contentExtentTicks = 0;
    let measureNumerator = currentNumerator;
    let measureDenominator = currentDenominator;
    const lastChordStart = new Map<string, number>();

    for (const child of measure.children) {
      switch (child.name) {
        case 'attributes': {
          const divisionsElement = firstChild(child, 'divisions');
          if (divisionsElement) {
            const parsed = Number.parseInt(ownText(divisionsElement), 10);
            if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_DIVISIONS) {
              throw new Error(`MusicXML has an invalid <divisions> value "${ownText(divisionsElement)}".`);
            }
            if (parsed !== divisions) {
              // Ticks are relative to divisions, so rescale in-flight positions.
              const scale = parsed / divisions;
              measureStartTicks = Math.round(measureStartTicks * scale);
              cursorTicks = Math.round(cursorTicks * scale);
              contentExtentTicks = Math.round(contentExtentTicks * scale);
              for (const [key, value] of lastChordStart) {
                lastChordStart.set(key, Math.round(value * scale));
              }
              divisions = parsed;
            }
          }
          const keyElement = firstChild(child, 'key');
          if (keyElement && !result.key) {
            const fifths = parseInteger(childText(keyElement, 'fifths') ?? '0', 'fifths');
            if (fifths < -7 || fifths > 7) {
              throw new Error(`MusicXML has an invalid key signature (${fifths} fifths).`);
            }
            const modeText = (childText(keyElement, 'mode') ?? 'major').toLowerCase();
            result.key = { fifths, mode: modeText === 'minor' ? 'minor' : 'major' };
          }
          const timeElement = firstChild(child, 'time');
          if (timeElement) {
            const beatsText = childText(timeElement, 'beats');
            const beatTypeText = childText(timeElement, 'beat-type');
            if (beatsText !== null && beatTypeText !== null) {
              const numerator = Number.parseInt(beatsText, 10);
              const denominator = Number.parseInt(beatTypeText, 10);
              if (
                !Number.isFinite(numerator) ||
                !Number.isFinite(denominator) ||
                numerator <= 0 ||
                denominator <= 0
              ) {
                throw new Error(
                  `MusicXML has an invalid time signature "${beatsText}/${beatTypeText}".`,
                );
              }
              currentNumerator = numerator;
              currentDenominator = denominator;
              if (cursorTicks <= 0) {
                measureNumerator = numerator;
                measureDenominator = denominator;
              }
              result.timeSignatures.push({
                beat: (measureStartTicks + cursorTicks) / divisions,
                numerator,
                denominator,
              });
            }
          }
          break;
        }
        case 'backup': {
          cursorTicks = Math.max(0, cursorTicks - readMoveDuration(child));
          break;
        }
        case 'forward': {
          cursorTicks += readMoveDuration(child);
          contentExtentTicks = Math.max(contentExtentTicks, cursorTicks);
          break;
        }
        case 'sound': {
          parseSoundTempo(child, (measureStartTicks + cursorTicks) / divisions, divisions, result.tempos);
          break;
        }
        case 'direction': {
          parseDirection(child, measureStartTicks + cursorTicks, divisions, result.tempos);
          break;
        }
        case 'note': {
          const isChord = firstChild(child, 'chord') !== null;
          const isGrace = firstChild(child, 'grace') !== null;
          const isCue = firstChild(child, 'cue') !== null;
          if (isGrace || isCue) break;

          const voiceText = childText(child, 'voice');
          const voiceNumber = voiceText !== null ? Number.parseInt(voiceText, 10) : null;
          const voiceKey = Number.isFinite(voiceNumber) && voiceNumber !== null ? String(voiceNumber) : '1';
          const staffText = childText(child, 'staff');
          const staffNumber = staffText !== null ? Number.parseInt(staffText, 10) : null;
          const staff = Number.isFinite(staffNumber) && staffNumber !== null ? staffNumber : null;
          const chordKey = `${voiceKey}|${staff ?? 0}`;

          const durationText = childText(child, 'duration');
          let durationTicks: number;
          if (durationText !== null) {
            const parsedDuration = Number.parseInt(durationText, 10);
            if (!Number.isFinite(parsedDuration) || parsedDuration < 0) {
              throw new Error(`MusicXML has an invalid <duration> value "${durationText}".`);
            }
            durationTicks = parsedDuration;
          } else {
            const typeText = (childText(child, 'type') ?? '').trim().toLowerCase();
            const typeBeats = TYPE_BEATS[typeText];
            if (typeBeats === undefined) {
              throw new Error('MusicXML <note> is missing a <duration> element.');
            }
            const dots = childrenNamed(child, 'dot').length;
            let factor = 1;
            if (dots === 1) factor = 1.5;
            else if (dots === 2) factor = 1.75;
            durationTicks = Math.max(1, Math.round(typeBeats * factor * divisions));
          }

          let startTicks: number;
          if (isChord) {
            const previousStart = lastChordStart.get(chordKey);
            if (previousStart === undefined) {
              throw new Error('MusicXML chord note is missing the note it belongs to.');
            }
            startTicks = previousStart;
          } else {
            startTicks = measureStartTicks + cursorTicks;
            cursorTicks += durationTicks;
            lastChordStart.set(chordKey, startTicks);
            contentExtentTicks = Math.max(contentExtentTicks, cursorTicks);
          }

          if (firstChild(child, 'rest')) break;
          if (durationTicks <= 0) {
            throw new Error('MusicXML <note> has a zero or invalid duration.');
          }
          const pitchElement = firstChild(child, 'pitch');
          if (!pitchElement) {
            throw new Error('MusicXML <note> has neither a <pitch> nor a <rest>.');
          }
          const midi = parsePitch(pitchElement);

          noteBudget.count += 1;
          if (noteBudget.count > MAX_NOTES) {
            throw new Error(`MusicXML contains more than ${MAX_NOTES} notes; refusing to import it.`);
          }

          const tieInfo = readTieInfo(child);
          const parsed: ParsedNote = {
            midi,
            start: startTicks / divisions,
            duration: durationTicks / divisions,
            velocity: 80,
            staff,
            voice: Number.isFinite(voiceNumber) && voiceNumber !== null ? voiceNumber : null,
            part: partIndex,
            tieStart: tieInfo.start,
            tieStop: tieInfo.stop,
          };

          const tieKey = `${staff ?? 0}|${voiceKey}|${midi}`;
          const pending = tiePending.get(tieKey);
          if (pending && parsed.tieStop) {
            const mergedEnd = Math.max(
              pending.start + pending.duration,
              parsed.start + parsed.duration,
            );
            pending.duration = mergedEnd - pending.start;
            if (parsed.tieStart) tiePending.set(tieKey, pending);
            else tiePending.delete(tieKey);
          } else {
            if (pending) tiePending.delete(tieKey);
            result.notes.push(parsed);
            if (parsed.tieStart) tiePending.set(tieKey, parsed);
          }
          break;
        }
        default:
          break;
      }
    }

    let measureLength = measureBeats({
      numerator: measureNumerator,
      denominator: measureDenominator,
    });
    if (!Number.isFinite(measureLength) || measureLength <= 0 || measureLength > 4096) {
      throw new Error('MusicXML has an invalid measure length.');
    }
    // Pickup (anacrusis) measures are flagged implicit and may be shorter than
    // the time signature; following measures start after their content.
    const isImplicit = (measure.attributes.implicit ?? '').toLowerCase() === 'yes';
    if (isImplicit && contentExtentTicks > 0) {
      const extentBeats = contentExtentTicks / divisions;
      if (extentBeats < measureLength - 1e-9) measureLength = extentBeats;
    }
    measureStartTicks += Math.round(measureLength * divisions);
  }

  result.divisions = divisions;
  return result;
}

function dedupeByBeat<T extends { beat: number }>(events: T[]): T[] {
  const sorted = [...events].sort((a, b) => a.beat - b.beat);
  const result: T[] = [];
  for (const event of sorted) {
    const last = result[result.length - 1];
    if (last && Math.abs(last.beat - event.beat) < 1e-9) result[result.length - 1] = event;
    else result.push(event);
  }
  return result;
}

function assignHands(notes: ParsedNote[], partCount: number, partNotes: Map<number, ParsedNote[]>): Hand[] {
  const hands: Hand[] = notes.map((note) => (note.midi < 60 ? 'left' : 'right'));
  const hasExplicitStaff = notes.some((note) => note.staff !== null);
  if (hasExplicitStaff) {
    notes.forEach((note, index) => {
      if (note.staff === 2) hands[index] = 'left';
      else if (note.staff !== null) hands[index] = 'right';
      else hands[index] = note.midi < 60 ? 'left' : 'right';
    });
    return hands;
  }

  const partsWithNotes = [...partNotes.entries()].filter(([, list]) => list.length > 0);
  if (partsWithNotes.length >= 2) {
    const means = partsWithNotes.map(([part, list]) => ({
      part,
      mean: list.reduce((sum, note) => sum + note.midi, 0) / list.length,
    }));
    means.sort((a, b) => a.mean - b.mean || a.part - b.part);
    const handByPart = new Map<number, Hand>();
    if (means.length === 2) {
      if (Math.abs(means[0].mean - means[1].mean) < 1e-9) {
        // Equal registers: follow the usual piano convention (part 1 = right).
        handByPart.set(means[0].part, 'right');
        handByPart.set(means[1].part, 'left');
      } else {
        handByPart.set(means[0].part, 'left');
        handByPart.set(means[1].part, 'right');
      }
    } else {
      for (const entry of means) handByPart.set(entry.part, entry.mean < 60 ? 'left' : 'right');
    }
    notes.forEach((note, index) => {
      hands[index] = handByPart.get(note.part) ?? hands[index];
    });
    return hands;
  }

  if (partCount >= 2) {
    // Multiple parts but only one has notes: fall back to the pitch split.
    return hands;
  }
  return hands;
}

/**
 * Parses a MusicXML `score-partwise` document into a `Score`.
 *
 * Throws a readable `Error` for empty, truncated, malformed or unsupported
 * input.
 */
export function parseMusicXml(xml: string, fallbackTitle = 'Imported score'): Score {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new Error('This MusicXML file is empty.');
  }
  const root = parseXml(xml);
  if (root.name !== 'score-partwise') {
    throw new Error(
      `Unsupported MusicXML root element <${root.name}>; only <score-partwise> is supported.`,
    );
  }

  const work = firstChild(root, 'work');
  const workTitle = work ? (childText(work, 'work-title') ?? '') : '';
  const movementTitle = childText(root, 'movement-title') ?? '';
  const partList = firstChild(root, 'part-list');
  let partListName = '';
  if (partList) {
    const scorePart = firstChild(partList, 'score-part');
    if (scorePart) partListName = childText(scorePart, 'part-name') ?? '';
  }

  let composer = '';
  const identification = firstChild(root, 'identification');
  if (identification) {
    const creators = childrenNamed(identification, 'creator');
    const composerCreator =
      creators.find((element) => (element.attributes.type ?? '').toLowerCase() === 'composer') ??
      creators[0];
    composer = ownText(composerCreator ?? null);
  }

  const partElements = childrenNamed(root, 'part');
  if (partElements.length === 0) {
    throw new Error('MusicXML file contains no <part> elements.');
  }
  if (partElements.length > MAX_PARTS) {
    throw new Error(`MusicXML file has too many parts (limit ${MAX_PARTS}).`);
  }

  const budget = { count: 0 };
  const parts: PartResult[] = [];
  const partNotes = new Map<number, ParsedNote[]>();
  for (let index = 0; index < partElements.length; index += 1) {
    const parsedPart = parsePart(partElements[index], index, budget);
    parts.push(parsedPart);
    partNotes.set(index, parsedPart.notes);
  }

  const allParsed = parts.flatMap((part) => part.notes);
  const hands = assignHands(allParsed, parts.length, partNotes);

  const noteEvents: NoteEvent[] = allParsed.map((note, index) => ({
    id: `xml-${index + 1}`,
    midi: note.midi,
    start: note.start,
    duration: note.duration,
    velocity: note.velocity,
    hand: hands[index],
    voice: note.voice !== null && note.voice >= 1 && note.voice <= 2 ? note.voice : undefined,
  }));

  const tempo = dedupeByBeat(parts.flatMap((part) => part.tempos));
  const timeSignatures = dedupeByBeat(parts.flatMap((part) => part.timeSignatures));
  const keySignature: KeySignature =
    parts.find((part) => part.key !== null)?.key ?? DEFAULT_KEY_SIGNATURE;
  const divisions = parts[0] ? parts[0].divisions : DEFAULT_PPQ;

  const title = workTitle || movementTitle || partListName || fallbackTitle;
  return createScore({
    title,
    composer,
    notes: noteEvents,
    tempo,
    timeSignatures,
    keySignature,
    ppq: divisions,
    source: 'musicxml',
    lengthBeats: notesEndBeat(noteEvents),
  });
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

interface LayoutMeasure {
  start: number;
  end: number;
}

interface XmlSegment {
  measure: number;
  start: number;
  end: number;
  midi: number;
  hand: Hand;
  staff: 1 | 2;
  voice: number;
  tieStart: boolean;
  tieStop: boolean;
}

const NOTE_TYPE_TABLE: { beats: number; type: string; dots: number }[] = [
  { beats: 8, type: 'breve', dots: 0 },
  { beats: 6, type: 'whole', dots: 1 },
  { beats: 4, type: 'whole', dots: 0 },
  { beats: 3, type: 'half', dots: 1 },
  { beats: 2, type: 'half', dots: 0 },
  { beats: 1.5, type: 'quarter', dots: 1 },
  { beats: 1, type: 'quarter', dots: 0 },
  { beats: 0.75, type: 'eighth', dots: 1 },
  { beats: 0.5, type: 'eighth', dots: 0 },
  { beats: 0.375, type: '16th', dots: 1 },
  { beats: 0.25, type: '16th', dots: 0 },
  { beats: 0.1875, type: '32nd', dots: 1 },
  { beats: 0.125, type: '32nd', dots: 0 },
  { beats: 0.09375, type: '64th', dots: 1 },
  { beats: 0.0625, type: '64th', dots: 0 },
];

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1e6) / 1e6;
  return String(rounded);
}

function clampFifths(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(7, Math.max(-7, Math.round(value)));
}

/** Lays out regular measures: a time-signature change takes effect at the next bar line. */
function layoutMeasures(score: Score): LayoutMeasure[] {
  const totalBeats = Math.max(score.lengthBeats, notesEndBeat(score.notes), 0);
  const measures: LayoutMeasure[] = [];
  let beat = 0;
  while (measures.length < MAX_EXPORT_MEASURES && beat < totalBeats - 1e-9) {
    const signature = timeSignatureAt(score, beat);
    const length = measureBeats(signature);
    if (!Number.isFinite(length) || length <= 0 || length > 4096) {
      throw new Error('Score has an invalid time signature; cannot export MusicXML.');
    }
    measures.push({ start: beat, end: beat + length });
    beat += length;
  }
  if (beat < totalBeats - 1e-9) {
    throw new Error(
      `Score is too long to export as MusicXML (limit ${MAX_EXPORT_MEASURES} measures).`,
    );
  }
  if (measures.length === 0) {
    const signature = timeSignatureAt(score, 0);
    measures.push({ start: 0, end: measureBeats(signature) });
  }
  return measures;
}

function chooseDivisions(score: Score, measures: LayoutMeasure[]): number {
  const values: number[] = [];
  for (const note of score.notes) {
    values.push(note.start, note.duration, note.start + note.duration);
  }
  for (const event of score.tempo) values.push(event.beat);
  for (const event of score.timeSignatures) values.push(event.beat);
  for (const measure of measures) values.push(measure.start, measure.end);
  const fits = (division: number): boolean => {
    for (const value of values) {
      const scaled = value * division;
      if (!Number.isFinite(scaled)) return false;
      if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return false;
    }
    return true;
  };
  const ppq = Math.min(0x7fff, Math.max(1, Math.round(score.ppq || DEFAULT_PPQ)));
  for (const candidate of [ppq, 480, 960, 1920, 9600, 1_000_000]) {
    if (fits(candidate)) return candidate;
  }
  // Last resort: fine enough that per-value rounding stays far below 1e-6 beats.
  return 10_000_000;
}

function pitchXml(midi: number): string {
  const safeMidi = Math.min(127, Math.max(0, Math.round(midi)));
  const pitchClass = ((safeMidi % 12) + 12) % 12;
  const octave = Math.floor(safeMidi / 12) - 1;
  const sharpSteps = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
  const alters = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
  const step = sharpSteps[pitchClass];
  const alter = alters[pitchClass];
  const alterXml = alter === 0 ? '' : `<alter>${alter}</alter>`;
  return `<pitch><step>${step}</step>${alterXml}<octave>${octave}</octave></pitch>`;
}

function typeXmlFor(durationBeats: number): string {
  for (const entry of NOTE_TYPE_TABLE) {
    if (Math.abs(entry.beats - durationBeats) < 1e-9) {
      return `<type>${entry.type}</type>${'<dot/>'.repeat(entry.dots)}`;
    }
  }
  return '';
}

function directionXml(bpm: number, offsetTicks: number): string {
  const bpmText = formatNumber(bpm);
  const offset = offsetTicks > 0 ? `<offset>${offsetTicks}</offset>` : '';
  return (
    '<direction placement="above"><direction-type><metronome>' +
    `<beat-unit>quarter</beat-unit><per-minute>${bpmText}</per-minute>` +
    `</metronome></direction-type>${offset}<sound tempo="${bpmText}"/></direction>`
  );
}

function noteXml(segment: XmlSegment, isChord: boolean, durationTicks: number, divisions: number): string {
  const durationBeats = durationTicks / divisions;
  const ties: string[] = [];
  const tied: string[] = [];
  if (segment.tieStop) {
    ties.push('<tie type="stop"/>');
    tied.push('<tied type="stop"/>');
  }
  if (segment.tieStart) {
    ties.push('<tie type="start"/>');
    tied.push('<tied type="start"/>');
  }
  const typeXml = typeXmlFor(durationBeats);
  const notationsXml = tied.length ? `<notations>${tied.join('')}</notations>` : '';
  return (
    '<note>' +
    (isChord ? '<chord/>' : '') +
    pitchXml(segment.midi) +
    `<duration>${durationTicks}</duration>` +
    ties.join('') +
    `<voice>${segment.voice}</voice>` +
    typeXml +
    `<staff>${segment.staff}</staff>` +
    notationsXml +
    '</note>'
  );
}

/**
 * Serialises `score` as a two-staff MusicXML `score-partwise` document.
 * Re-parsing the result with {@link parseMusicXml} reproduces every note's
 * pitch, hand, start and duration.
 */
export function writeMusicXml(score: Score): string {
  const prepared = normalizeScore(score);
  const measures = layoutMeasures(prepared);
  const divisions = chooseDivisions(prepared, measures);
  const measureBaseTicks = measures.map((measure) => Math.max(0, Math.round(measure.start * divisions)));
  const toTick = (beat: number): number => Math.max(0, Math.round(beat * divisions));

  // Greedy voice assignment per hand so overlapping notes get separate voices.
  // Notes that share an onset (a chord) always share one voice.
  const voiceByNote = new Map<string, number>();
  for (const hand of ['right', 'left'] as const) {
    const voiceEnds: number[] = [];
    let lastStart = Number.NEGATIVE_INFINITY;
    let lastVoice = -1;
    for (const note of prepared.notes) {
      if (note.hand !== hand) continue;
      let voiceIndex: number;
      if (lastVoice >= 0 && Math.abs(note.start - lastStart) < 1e-9) {
        voiceIndex = lastVoice;
      } else {
        voiceIndex = voiceEnds.findIndex((end) => end <= note.start + 1e-9);
        if (voiceIndex === -1) {
          if (voiceEnds.length < MAX_VOICES) {
            voiceEnds.push(0);
            voiceIndex = voiceEnds.length - 1;
          } else {
            voiceIndex = voiceEnds.length - 1;
          }
        }
        lastStart = note.start;
        lastVoice = voiceIndex;
      }
      voiceEnds[voiceIndex] = Math.max(voiceEnds[voiceIndex], note.start + note.duration);
      voiceByNote.set(note.id, voiceIndex + 1);
    }
  }

  // Split notes into measure-sized segments, tied where they cross a bar line.
  const segments: XmlSegment[] = [];
  // Notes are sorted by start, so this pointer only ever moves forward. It must
  // be separate from the per-note segment walk (which may run into later
  // measures for long notes).
  let startMeasureIndex = 0;
  for (const note of prepared.notes) {
    while (
      startMeasureIndex < measures.length - 1 &&
      note.start >= measures[startMeasureIndex].end - 1e-9
    ) {
      startMeasureIndex += 1;
    }
    let measureIndex = startMeasureIndex;
    const staff: 1 | 2 = note.hand === 'left' ? 2 : 1;
    const voice = voiceByNote.get(note.id) ?? 1;
    const noteEnd = note.start + note.duration;
    let cursor = note.start;
    let guard = 0;
    while (cursor < noteEnd - 1e-12) {
      guard += 1;
      if (guard > MAX_EXPORT_MEASURES * 4) {
        throw new Error('Could not lay out score notes for MusicXML export.');
      }
      while (measureIndex < measures.length - 1 && cursor >= measures[measureIndex].end - 1e-9) {
        measureIndex += 1;
      }
      const measure = measures[measureIndex];
      if (!measure) break;
      const segmentEnd = Math.min(noteEnd, measure.end);
      if (segmentEnd <= cursor + 1e-12) {
        measureIndex += 1;
        if (measureIndex >= measures.length) break;
        continue;
      }
      segments.push({
        measure: measureIndex,
        start: cursor,
        end: segmentEnd,
        midi: note.midi,
        hand: note.hand,
        staff,
        voice,
        // `tieStart` ties this segment into the next measure; `tieStop`
        // continues a tie that began in an earlier measure.
        tieStart: segmentEnd < noteEnd - 1e-9,
        tieStop: cursor > note.start + 1e-9,
      });
      cursor = segmentEnd;
      if (cursor < noteEnd - 1e-9) {
        measureIndex += 1;
        if (measureIndex >= measures.length) {
          throw new Error('Score notes extend beyond the exportable range.');
        }
      }
    }
  }

  const byMeasure: XmlSegment[][] = measures.map(() => []);
  for (const segment of segments) byMeasure[segment.measure].push(segment);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
  );
  lines.push('<score-partwise version="4.0">');
  const title = escapeXmlText(prepared.title.trim());
  if (title) lines.push(`  <work><work-title>${title}</work-title></work>`);
  const composer = escapeXmlText(prepared.composer.trim());
  lines.push(
    '  <identification>' +
      (composer ? `<creator type="composer">${composer}</creator>` : '') +
      '<encoding><software>Piano Studio</software></encoding>' +
      '</identification>',
  );
  lines.push(
    '  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>',
  );
  lines.push('  <part id="P1">');

  let previousSignature: { numerator: number; denominator: number } | null = null;
  const fifths = clampFifths(prepared.keySignature.fifths);
  const mode = prepared.keySignature.mode === 'minor' ? 'minor' : 'major';

  for (let index = 0; index < measures.length; index += 1) {
    const measure = measures[index];
    const signature = timeSignatureAt(prepared, measure.start);
    const content: string[] = [];
    const attributes: string[] = [];
    if (index === 0) {
      attributes.push(`<divisions>${divisions}</divisions>`);
      attributes.push(`<key><fifths>${fifths}</fifths><mode>${mode}</mode></key>`);
      attributes.push(
        `<time><beats>${signature.numerator}</beats><beat-type>${signature.denominator}</beat-type></time>`,
      );
      attributes.push('<staves>2</staves>');
      attributes.push('<clef number="1"><sign>G</sign><line>2</line></clef>');
      attributes.push('<clef number="2"><sign>F</sign><line>4</line></clef>');
    } else if (
      previousSignature &&
      (previousSignature.numerator !== signature.numerator ||
        previousSignature.denominator !== signature.denominator)
    ) {
      attributes.push(
        `<time><beats>${signature.numerator}</beats><beat-type>${signature.denominator}</beat-type></time>`,
      );
    }
    previousSignature = signature;
    if (attributes.length) content.push(`<attributes>${attributes.join('')}</attributes>`);

    for (const event of prepared.tempo) {
      if (!Number.isFinite(event.beat)) continue;
      if (event.beat < measure.start - 1e-9 || event.beat >= measure.end - 1e-9) continue;
      const offsetTicks = Math.max(0, toTick(event.beat) - measureBaseTicks[index]);
      content.push(directionXml(event.bpm, offsetTicks));
    }

    const groups: { voice: number; segs: XmlSegment[] }[] = [];
    for (const staff of [1, 2] as const) {
      const measureSegments = byMeasure[index];
      const voiceNumbers = [
        ...new Set(measureSegments.filter((segment) => segment.staff === staff).map((segment) => segment.voice)),
      ].sort((a, b) => a - b);
      for (const voice of voiceNumbers) {
        groups.push({
          voice,
          segs: measureSegments.filter(
            (segment) => segment.staff === staff && segment.voice === voice,
          ),
        });
      }
    }

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      const sorted = [...group.segs].sort(
        (a, b) =>
          a.start - b.start ||
          b.end - b.start - (a.end - a.start) ||
          a.midi - b.midi,
      );
      let cursorTick = measureBaseTicks[index];
      let pointer = 0;
      while (pointer < sorted.length) {
        const first = sorted[pointer];
        const startTick = toTick(first.start);
        if (startTick > cursorTick) {
          content.push(`<forward><duration>${startTick - cursorTick}</duration></forward>`);
        }
        const chord: XmlSegment[] = [first];
        pointer += 1;
        while (
          pointer < sorted.length &&
          Math.abs(sorted[pointer].start - first.start) < 1e-9
        ) {
          chord.push(sorted[pointer]);
          pointer += 1;
        }
        chord.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.midi - b.midi);
        const baseStartTick = Math.max(startTick, cursorTick);
        let chordEndTick = baseStartTick;
        for (let chordIndex = 0; chordIndex < chord.length; chordIndex += 1) {
          const segment = chord[chordIndex];
          const segmentStartTick = baseStartTick;
          const segmentEndTick = Math.max(segmentStartTick + 1, toTick(segment.end));
          const durationTicks = segmentEndTick - segmentStartTick;
          content.push(noteXml(segment, chordIndex > 0, durationTicks, divisions));
          if (chordIndex === 0) chordEndTick = segmentEndTick;
        }
        cursorTick = chordEndTick;
      }
      const progressed = cursorTick - measureBaseTicks[index];
      if (groupIndex < groups.length - 1 && progressed > 0) {
        content.push(`<backup><duration>${progressed}</duration></backup>`);
      }
    }

    if (content.length === 0) lines.push(`    <measure number="${index + 1}"/>`);
    else lines.push(`    <measure number="${index + 1}">${content.join('')}</measure>`);
  }

  lines.push('  </part>');
  lines.push('</score-partwise>');
  return lines.join('\n');
}
