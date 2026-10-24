import { describe, expect, it } from 'vitest';
import {
  isBlackKey,
  keySignatureName,
  midiToFrequency,
  midiToKeyName,
  midiToName,
  midiToParts,
  nameToMidi,
} from './pitch';

describe('pitch naming', () => {
  it('maps MIDI numbers to scientific pitch', () => {
    expect(midiToName(21)).toBe('A0');
    expect(midiToName(60)).toBe('C4');
    expect(midiToName(69)).toBe('A4');
    expect(midiToName(108)).toBe('C8');
    expect(midiToParts(61)).toEqual({ pitchClass: 'C#', octave: 4 });
  });

  it('parses note names back to MIDI', () => {
    expect(nameToMidi('C4')).toBe(60);
    expect(nameToMidi('A0')).toBe(21);
    expect(nameToMidi('F#3')).toBe(54);
    expect(nameToMidi('Bb2')).toBe(46);
    expect(nameToMidi('H4')).toBeNull();
    expect(nameToMidi('C')).toBeNull();
  });

  it('identifies black keys', () => {
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(60)).toBe(false);
    expect(isBlackKey(70)).toBe(true);
    expect(isBlackKey(71)).toBe(false);
  });

  it('uses A4 = 440 Hz', () => {
    expect(midiToFrequency(69)).toBeCloseTo(440, 9);
    expect(midiToFrequency(81)).toBeCloseTo(880, 9);
    expect(midiToFrequency(60)).toBeCloseTo(261.625565, 5);
  });

  it('names key signatures', () => {
    expect(keySignatureName(0, 'major')).toBe('C major');
    expect(keySignatureName(2, 'major')).toBe('D major');
    expect(keySignatureName(-3, 'major')).toBe('Eb major');
    expect(keySignatureName(1, 'minor')).toBe('E minor');
    expect(keySignatureName(-2, 'minor')).toBe('G minor');
  });

  it('spells notes according to a key signature', () => {
    expect(midiToKeyName(63, -3)).toBe('Eb4');
    expect(midiToKeyName(66, 2)).toBe('F#4');
    expect(midiToKeyName(60, 0)).toBe('C4');
  });
});
