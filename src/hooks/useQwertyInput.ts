import { useEffect, useRef } from 'react';
import { QWERTY_KEYMAP, octaveBaseMidi } from '../music/keymap';
import { MAX_PIANO_MIDI, MIN_PIANO_MIDI } from '../music/pitch';

export interface QwertyInputOptions {
  enabled: boolean;
  octave: number;
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
  onTogglePlay?: () => void;
  onOctaveChange: (direction: 1 | -1) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Global computer-keyboard piano input:
 * A S D F G H J K = white keys, W E T Y U = black keys, Z/X = octave down/up.
 * Space is left to the transport.
 */
export function useQwertyInput(options: QwertyInputOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const pressed = useRef(new Map<string, number>());
  const { enabled } = options;

  useEffect(() => {
    const releaseAll = () => {
      for (const midi of pressed.current.values()) optionsRef.current.onNoteOff(midi);
      pressed.current.clear();
    };

    if (!enabled) {
      releaseAll();
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === ' ') {
        if (event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') return;
        event.preventDefault();
        optionsRef.current.onTogglePlay?.();
        return;
      }
      if (key === 'z') {
        optionsRef.current.onOctaveChange(-1);
        return;
      }
      if (key === 'x') {
        optionsRef.current.onOctaveChange(1);
        return;
      }
      const semitone = QWERTY_KEYMAP[key];
      if (semitone === undefined) return;
      if (pressed.current.has(key)) return;
      const midi = octaveBaseMidi(optionsRef.current.octave) + semitone;
      if (midi < MIN_PIANO_MIDI || midi > MAX_PIANO_MIDI) return;
      pressed.current.set(key, midi);
      optionsRef.current.onNoteOn(midi, 92);
      event.preventDefault();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const midi = pressed.current.get(key);
      if (midi !== undefined) {
        pressed.current.delete(key);
        optionsRef.current.onNoteOff(midi);
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAll);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      releaseAll();
    };
  }, [enabled]);
}
