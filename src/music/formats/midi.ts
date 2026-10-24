/**
 * Standard MIDI File import/export for Piano Studio.
 *
 * The parser is defensive: imported files are untrusted, so it validates the
 * header and chunk bounds, supports running status, skips SysEx and unknown
 * meta events, pairs note-on/note-off events (velocity-0 note-on counts as
 * note-off), caps the note/event counts and throws readable `Error`s for
 * corrupt input. All musical positions are converted to quarter-note beats
 * using the file's own ticks-per-quarter-note value.
 */
import { createScore, normalizeScore, notesEndBeat } from '../score';
import type { Hand, KeySignature, NoteEvent, Score, TempoEvent, TimeSignatureEvent } from '../types';
import { DEFAULT_PPQ } from '../types';

const MAX_NOTES = 50_000;
const MAX_EVENTS = 2_000_000;
const MAX_TRACKS = 256;
const MAX_MIDI_BYTES = 64 * 1024 * 1024;

const DRUM_CHANNEL = 9;

interface RawMidiNote {
  midi: number;
  startTick: number;
  endTick: number;
  velocity: number;
  channel: number;
  track: number;
}

interface RawTempo {
  tick: number;
  bpm: number;
}

interface RawTimeSignature {
  tick: number;
  numerator: number;
  denominator: number;
}

interface RawTrack {
  name: string;
  texts: string[];
  notes: RawMidiNote[];
  tempos: RawTempo[];
  timeSignatures: RawTimeSignature[];
  key: KeySignature | null;
}

interface EventBudget {
  notes: number;
  events: number;
}

class MidiReader {
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  readU8(): number {
    if (this.pos >= this.bytes.length) throw new Error('MIDI file is truncated.');
    const value = this.bytes[this.pos];
    this.pos += 1;
    return value;
  }

  readU16(): number {
    return (this.readU8() << 8) | this.readU8();
  }

  readU32(): number {
    const value =
      (this.readU8() << 24) | (this.readU8() << 16) | (this.readU8() << 8) | this.readU8();
    return value >>> 0;
  }

  readString(length: number): string {
    let out = '';
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(this.readU8());
    return out;
  }

  readBytes(length: number): Uint8Array {
    if (length < 0 || this.pos + length > this.bytes.length) throw new Error('MIDI file is truncated.');
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  skip(length: number): void {
    this.readBytes(length);
  }

  readVLQ(): number {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = this.readU8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Invalid MIDI variable-length quantity.');
  }
}

function asUint8Array(data: ArrayBuffer): Uint8Array {
  const candidate = data as unknown;
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('MIDI import expects binary file data.');
  }
  const bytes = new Uint8Array(data as ArrayBuffer);
  return bytes;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    let out = '';
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
  }
}

function roundBpm(bpm: number): number {
  return Math.round(bpm * 1000) / 1000;
}

function parseTrack(reader: MidiReader, trackIndex: number, budget: EventBudget): RawTrack {
  const track: RawTrack = {
    name: '',
    texts: [],
    notes: [],
    tempos: [],
    timeSignatures: [],
    key: null,
  };
  let tick = 0;
  let runningStatus = 0;
  const openNotes = new Map<number, { startTick: number; velocity: number }[]>();

  const closeAll = (endTick: number): void => {
    for (const [key, queue] of openNotes) {
      const channel = key >>> 8;
      const midi = key & 0xff;
      for (const open of queue) {
        budget.notes += 1;
        if (budget.notes > MAX_NOTES) {
          throw new Error(`MIDI file contains more than ${MAX_NOTES} notes; refusing to import it.`);
        }
        track.notes.push({
          midi,
          startTick: open.startTick,
          endTick: Math.max(endTick, open.startTick + 1),
          velocity: open.velocity,
          channel,
          track: trackIndex,
        });
      }
    }
    openNotes.clear();
  };

  while (reader.remaining > 0) {
    const delta = reader.readVLQ();
    tick += delta;
    budget.events += 1;
    if (budget.events > MAX_EVENTS) {
      throw new Error('MIDI file contains too many events; refusing to import it.');
    }

    const first = reader.readU8();
    let status: number;
    let firstData: number | null = null;
    if (first < 0x80) {
      if (runningStatus === 0) {
        throw new Error('Invalid MIDI file: data byte without a preceding status byte.');
      }
      status = runningStatus;
      firstData = first;
    } else {
      status = first;
    }

    if (status === 0xff) {
      const metaType = reader.readU8();
      const length = reader.readVLQ();
      const payload = reader.readBytes(length);
      if (metaType === 0x2f) {
        // End of track.
        closeAll(Math.max(tick, 1));
        reader.pos = reader.bytes.length;
        break;
      }
      if (metaType === 0x51 && payload.length >= 3) {
        const microseconds = (payload[0] << 16) | (payload[1] << 8) | payload[2];
        if (microseconds > 0) {
          track.tempos.push({ tick, bpm: roundBpm(60_000_000 / microseconds) });
        }
      } else if (metaType === 0x58 && payload.length >= 2) {
        const numerator = payload[0];
        const denominatorPower = payload[1];
        if (numerator > 0 && denominatorPower <= 7) {
          track.timeSignatures.push({ tick, numerator, denominator: 2 ** denominatorPower });
        }
      } else if (metaType === 0x59 && payload.length >= 1) {
        const fifths = payload[0] > 127 ? payload[0] - 256 : payload[0];
        if (!track.key && fifths >= -7 && fifths <= 7) {
          track.key = { fifths, mode: payload.length >= 2 && payload[1] === 1 ? 'minor' : 'major' };
        }
      } else if (metaType === 0x03 && !track.name) {
        track.name = decodeText(payload).trim();
      } else if (metaType === 0x01) {
        const text = decodeText(payload).trim();
        if (text) track.texts.push(text);
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = reader.readVLQ();
      reader.skip(length);
      continue;
    }
    if (status < 0x80 || status >= 0xf0) {
      throw new Error(`Unsupported MIDI status byte 0x${status.toString(16)}.`);
    }

    runningStatus = status;
    const kind = status >> 4;
    const channel = status & 0x0f;
    const dataBytes = kind === 0x0c || kind === 0x0d ? 1 : 2;
    const rawData1 = firstData === null ? reader.readU8() : firstData;
    const rawData2 = dataBytes === 2 ? reader.readU8() : 0;
    const data1 = rawData1 & 0x7f;
    const data2 = rawData2 & 0x7f;

    if (kind === 0x08) {
      closeNote(channel, data1, tick);
    } else if (kind === 0x09) {
      if (data2 === 0) {
        closeNote(channel, data1, tick);
      } else if (channel !== DRUM_CHANNEL) {
        const key = (channel << 8) | data1;
        const queue = openNotes.get(key);
        const entry = { startTick: tick, velocity: data2 };
        if (queue) queue.push(entry);
        else openNotes.set(key, [entry]);
      }
    }
    // Other channel messages (pressure, control change, program, pitch bend)
    // are read for their data bytes but do not affect the score.
  }

  closeAll(Math.max(tick, 1));
  return track;

  function closeNote(channel: number, midi: number, endTick: number): void {
    const key = (channel << 8) | midi;
    const queue = openNotes.get(key);
    if (!queue || queue.length === 0) return;
    const open = queue.shift();
    if (!open) return;
    if (queue.length === 0) openNotes.delete(key);
    budget.notes += 1;
    if (budget.notes > MAX_NOTES) {
      throw new Error(`MIDI file contains more than ${MAX_NOTES} notes; refusing to import it.`);
    }
    track.notes.push({
      midi,
      startTick: open.startTick,
      endTick: Math.max(endTick, open.startTick + 1),
      velocity: open.velocity,
      channel,
      track: trackIndex,
    });
  }
}

function classifyTrackName(name: string): Hand | null {
  if (/left|bass|lh|lower|accomp/i.test(name)) return 'left';
  if (/right|treble|melody|rh|upper|lead/i.test(name)) return 'right';
  return null;
}

/** Assigns a hand to each source track (or channel) group. */
function assignGroupHands(groups: { key: number; notes: RawMidiNote[] }[]): Map<number, Hand> {
  const result = new Map<number, Hand>();
  if (groups.length === 0) return result;
  if (groups.length === 1) {
    for (const note of groups[0].notes) {
      result.set(groups[0].key, note.midi < 60 ? 'left' : 'right');
    }
    return result;
  }
  const means = groups.map((group) => ({
    key: group.key,
    mean: group.notes.reduce((sum, note) => sum + note.midi, 0) / Math.max(1, group.notes.length),
  }));
  means.sort((a, b) => a.mean - b.mean || a.key - b.key);
  if (means.length === 2) {
    result.set(means[0].key, 'left');
    result.set(means[1].key, 'right');
    return result;
  }
  for (const entry of means) result.set(entry.key, entry.mean < 60 ? 'left' : 'right');
  return result;
}

/**
 * Parses a Standard MIDI File (format 0, 1 or 2) into a `Score`.
 *
 * All tracks are merged. Hands are derived from track or channel grouping
 * (lower/average-lower group becomes the left hand), falling back to a pitch
 * split at middle C.
 */
export function parseMidi(data: ArrayBuffer, fallbackTitle = 'Imported MIDI'): Score {
  const bytes = asUint8Array(data);
  if (bytes.length === 0) throw new Error('This MIDI file is empty.');
  if (bytes.length > MAX_MIDI_BYTES) throw new Error('MIDI file is too large to import.');
  if (bytes.length < 14) throw new Error('Not a Standard MIDI File: file is too short.');

  const reader = new MidiReader(bytes);
  const headerId = reader.readString(4);
  if (headerId !== 'MThd') throw new Error('Not a Standard MIDI File (missing "MThd" header).');
  const headerLength = reader.readU32();
  if (headerLength < 6) throw new Error('Corrupt MIDI header: header chunk is too small.');
  if (reader.remaining < headerLength) throw new Error('MIDI file is truncated (header chunk ends early).');
  const format = reader.readU16();
  const trackCount = reader.readU16();
  const division = reader.readU16();
  reader.skip(headerLength - 6);

  if (format > 2) throw new Error(`Unsupported MIDI file format ${format}.`);
  if (trackCount === 0) throw new Error('MIDI file contains no tracks.');
  if (trackCount > MAX_TRACKS) throw new Error('MIDI file has too many tracks to import.');
  if ((division & 0x8000) !== 0) {
    throw new Error('SMPTE-timed MIDI files are not supported.');
  }
  const ppq = division & 0x7fff;
  if (ppq === 0) throw new Error('Corrupt MIDI header: zero ticks per quarter note.');

  const budget: EventBudget = { notes: 0, events: 0 };
  const tracks: RawTrack[] = [];
  for (let index = 0; index < trackCount; index += 1) {
    if (reader.remaining === 0) {
      // Some writers declare one track too many; tolerate a clean end of file
      // once at least one full track has been read.
      if (index > 0) break;
      throw new Error('MIDI file is truncated (missing track chunk).');
    }
    if (reader.remaining < 8) throw new Error('MIDI file is truncated (incomplete track chunk).');
    const chunkId = reader.readString(4);
    if (chunkId !== 'MTrk') {
      throw new Error(`Corrupt MIDI file: expected "MTrk" for track ${index + 1}.`);
    }
    const chunkLength = reader.readU32();
    if (chunkLength > reader.remaining) {
      throw new Error('MIDI file is truncated (track data ends early).');
    }
    const trackBytes = reader.readBytes(chunkLength);
    tracks.push(parseTrack(new MidiReader(trackBytes), index, budget));
  }

  const trackNames = tracks.map((track) => track.name);
  const allNotes = tracks.flatMap((track) => track.notes);

  const noteTracks = [...new Set(allNotes.map((note) => note.track))];
  const channels = [...new Set(allNotes.map((note) => note.channel))];
  let handByTrack: Map<number, Hand> | null = null;
  let handByChannel: Map<number, Hand> | null = null;

  if (noteTracks.length >= 2) {
    const hints = new Map<number, Hand>();
    for (const trackId of noteTracks) {
      const hint = classifyTrackName(trackNames[trackId] ?? '');
      if (hint) hints.set(trackId, hint);
    }
    const hinted = [...hints.values()];
    if (hinted.includes('left') && hinted.includes('right')) {
      handByTrack = new Map();
      for (const trackId of noteTracks) handByTrack.set(trackId, hints.get(trackId) ?? 'right');
    } else {
      handByTrack = assignGroupHands(
        noteTracks.map((trackId) => ({
          key: trackId,
          notes: allNotes.filter((note) => note.track === trackId),
        })),
      );
    }
  } else if (channels.length >= 2) {
    handByChannel = assignGroupHands(
      channels.map((channel) => ({
        key: channel,
        notes: allNotes.filter((note) => note.channel === channel),
      })),
    );
  }

  const noteEvents: NoteEvent[] = allNotes.map((note, index) => {
    let hand: Hand;
    if (handByTrack) hand = handByTrack.get(note.track) ?? (note.midi < 60 ? 'left' : 'right');
    else if (handByChannel) hand = handByChannel.get(note.channel) ?? (note.midi < 60 ? 'left' : 'right');
    else hand = note.midi < 60 ? 'left' : 'right';
    return {
      id: `midi-${index + 1}`,
      midi: note.midi,
      start: note.startTick / ppq,
      duration: (note.endTick - note.startTick) / ppq,
      velocity: note.velocity,
      hand,
      track: note.track,
    };
  });

  const tempoByTick = new Map<number, number>();
  for (const track of tracks) {
    for (const tempo of track.tempos) tempoByTick.set(tempo.tick, tempo.bpm);
  }
  const tempo: TempoEvent[] = [...tempoByTick.entries()]
    .map(([tick, bpm]) => ({ beat: tick / ppq, bpm }))
    .sort((a, b) => a.beat - b.beat);

  const signatureByTick = new Map<number, { numerator: number; denominator: number }>();
  for (const track of tracks) {
    for (const signature of track.timeSignatures) {
      signatureByTick.set(signature.tick, {
        numerator: signature.numerator,
        denominator: signature.denominator,
      });
    }
  }
  const timeSignatures: TimeSignatureEvent[] = [...signatureByTick.entries()]
    .map(([tick, signature]) => ({ beat: tick / ppq, ...signature }))
    .sort((a, b) => a.beat - b.beat);

  const keySignature: KeySignature =
    tracks.find((track) => track.key !== null)?.key ?? { fifths: 0, mode: 'major' };

  let title = trackNames[0] ?? '';
  if (!title) {
    title = trackNames.find((name) => name && !/^(right|left) hand$/i.test(name)) ?? '';
  }
  if (!title) title = fallbackTitle;

  let composer = '';
  for (const track of tracks) {
    for (const text of track.texts) {
      const match = /^\s*composer\s*[:\-]\s*(.+)$/i.exec(text);
      if (match && match[1]) {
        composer = match[1].trim();
        break;
      }
    }
    if (composer) break;
  }

  return createScore({
    title,
    composer,
    notes: noteEvents,
    tempo,
    timeSignatures,
    keySignature,
    ppq,
    source: 'midi',
    lengthBeats: notesEndBeat(noteEvents),
  });
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

interface TrackEvent {
  tick: number;
  priority: number;
  bytes: number[];
}

function encodeVlq(value: number): number[] {
  let n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const bytes = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return bytes;
}

function uint32Bytes(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function metaEvent(type: number, payload: number[]): number[] {
  return [0xff, type, ...encodeVlq(payload.length), ...payload];
}

function textBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function encodeTrack(events: TrackEvent[]): Uint8Array {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  const body: number[] = [];
  let previousTick = 0;
  for (const event of sorted) {
    body.push(...encodeVlq(event.tick - previousTick));
    body.push(...event.bytes);
    previousTick = event.tick;
  }
  // End of track at the final event position.
  body.push(0x00, 0xff, 0x2f, 0x00);
  const header = [0x4d, 0x54, 0x72, 0x6b, ...uint32Bytes(body.length)];
  return new Uint8Array([...header, ...body]);
}

function clampInteger(value: number, min: number, max: number): number {
  const rounded = Math.round(Number.isFinite(value) ? value : min);
  return Math.min(max, Math.max(min, rounded));
}

/**
 * Serialises `score` as a format-1 Standard MIDI File.
 *
 * The first track carries tempo, time-signature and key-signature meta events
 * plus the title/composer; the following tracks hold the right and left hand
 * parts on separate channels.
 */
export function writeMidi(score: Score): Uint8Array {
  const safeScore = normalizeScore(score);
  const ppq = clampInteger(safeScore.ppq || DEFAULT_PPQ, 1, 0x7fff);
  const tickOf = (beat: number): number =>
    Number.isFinite(beat) ? Math.max(0, Math.round(beat * ppq)) : 0;

  const tempoEvents: TrackEvent[] = [];
  const title = safeScore.title.trim();
  if (title) {
    tempoEvents.push({ tick: 0, priority: 0, bytes: metaEvent(0x03, textBytes(title)) });
  }
  const composer = safeScore.composer.trim();
  if (composer) {
    tempoEvents.push({
      tick: 0,
      priority: 1,
      bytes: metaEvent(0x01, textBytes(`Composer: ${composer}`)),
    });
  }
  for (const event of safeScore.tempo) {
    if (!Number.isFinite(event.beat)) continue;
    const bpm = Number.isFinite(event.bpm) && event.bpm > 0 ? event.bpm : 120;
    const microseconds = clampInteger(60_000_000 / bpm, 1, 0xffffff);
    tempoEvents.push({
      tick: tickOf(event.beat),
      priority: 2,
      bytes: metaEvent(0x51, [
        (microseconds >>> 16) & 0xff,
        (microseconds >>> 8) & 0xff,
        microseconds & 0xff,
      ]),
    });
  }
  for (const signature of safeScore.timeSignatures) {
    if (!Number.isFinite(signature.beat)) continue;
    const numerator = clampInteger(signature.numerator, 1, 255);
    const denominator = clampInteger(signature.denominator, 1, 128);
    let power = 0;
    while (power < 7 && 2 ** (power + 1) <= denominator) power += 1;
    tempoEvents.push({
      tick: tickOf(signature.beat),
      priority: 3,
      bytes: metaEvent(0x58, [numerator, power, 24, 8]),
    });
  }
  tempoEvents.push({
    tick: 0,
    priority: 4,
    bytes: metaEvent(0x59, [
      clampInteger(safeScore.keySignature.fifths, -7, 7) & 0xff,
      safeScore.keySignature.mode === 'minor' ? 1 : 0,
    ]),
  });

  const buildNoteTrack = (hand: Hand, channel: number): Uint8Array | null => {
    const notes = safeScore.notes.filter((note) => note.hand === hand);
    if (notes.length === 0) return null;
    const events: TrackEvent[] = [
      {
        tick: 0,
        priority: 0,
        bytes: metaEvent(0x03, textBytes(hand === 'left' ? 'Left Hand' : 'Right Hand')),
      },
    ];
    for (const note of notes) {
      const startTick = tickOf(note.start);
      const endTick = Math.max(startTick + 1, tickOf(note.start + note.duration));
      const midi = clampInteger(note.midi, 0, 127);
      const velocity = clampInteger(note.velocity, 1, 127);
      events.push({
        tick: endTick,
        priority: 0,
        bytes: [0x80 | channel, midi, 0x40],
      });
      events.push({
        tick: startTick,
        priority: 1,
        bytes: [0x90 | channel, midi, velocity],
      });
    }
    return encodeTrack(events);
  };

  const trackChunks: Uint8Array[] = [encodeTrack(tempoEvents)];
  const right = buildNoteTrack('right', 0);
  const left = buildNoteTrack('left', 1);
  if (right) trackChunks.push(right);
  if (left) trackChunks.push(left);

  const header = [
    0x4d,
    0x54,
    0x68,
    0x64,
    0x00,
    0x00,
    0x00,
    0x06,
    0x00,
    0x01,
    (trackChunks.length >>> 8) & 0xff,
    trackChunks.length & 0xff,
    (ppq >>> 8) & 0xff,
    ppq & 0xff,
  ];
  const totalLength = header.length + trackChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(totalLength);
  out.set(header, 0);
  let offset = header.length;
  for (const chunk of trackChunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
