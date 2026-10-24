import { describe, expect, it } from 'vitest';
import { midiForKey, octaveBaseMidi, qwertyLabelForMidi } from './keymap';

describe('qwerty mapping', () => {
  it('maps octaves to MIDI', () => {
    expect(octaveBaseMidi(4)).toBe(60);
    expect(octaveBaseMidi(1)).toBe(24);
  });

  it('maps letters to MIDI at the selected octave', () => {
    expect(midiForKey('a', 4)).toBe(60);
    expect(midiForKey('w', 4)).toBe(61);
    expect(midiForKey('k', 4)).toBe(72);
    expect(midiForKey('k', 5)).toBe(84);
    expect(midiForKey('q', 4)).toBeNull();
  });

  it('labels keys back to QWERTY letters', () => {
    expect(qwertyLabelForMidi(60, 4)).toBe('A');
    expect(qwertyLabelForMidi(61, 4)).toBe('W');
    expect(qwertyLabelForMidi(72, 4)).toBe('K');
    expect(qwertyLabelForMidi(59, 4)).toBeNull();
  });
});
