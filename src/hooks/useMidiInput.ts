import { useCallback, useEffect, useRef, useState } from 'react';

export interface MidiInputState {
  supported: boolean;
  status: 'off' | 'requesting' | 'ready' | 'denied';
  devices: string[];
  connect: () => void;
}

/** Optional Web MIDI input: plays and shows notes from a connected keyboard. */
export function useMidiInput(options: {
  onNoteOn: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
}): MidiInputState {
  const callbacks = useRef(options);
  callbacks.current = options;
  const [supported, setSupported] = useState(false);
  const [requested, setRequested] = useState(false);
  const [status, setStatus] = useState<MidiInputState['status']>('off');
  const [devices, setDevices] = useState<string[]>([]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) return;
    setSupported(true);
  }, []);

  useEffect(() => {
    if (!requested) return;
    let cancelled = false;
    let access: MIDIAccess | null = null;

    const attach = () => {
      if (!access || cancelled) return;
      const names: string[] = [];
      access.inputs.forEach((input) => {
        names.push(input.name || 'MIDI keyboard');
        input.onmidimessage = (event: MIDIMessageEvent) => {
          const data = event.data;
          if (!data || data.length < 3) return;
          const statusByte = data[0] & 0xf0;
          const note = data[1];
          const velocity = data[2];
          if (statusByte === 0x90 && velocity > 0) callbacks.current.onNoteOn(note, velocity);
          else if (statusByte === 0x80 || (statusByte === 0x90 && velocity === 0)) {
            callbacks.current.onNoteOff(note);
          }
        };
      });
      setDevices(names);
    };

    if (typeof navigator.requestMIDIAccess !== 'function') return;

    setStatus('requesting');
    navigator
      .requestMIDIAccess()
      .then((midiAccess) => {
        if (cancelled) return;
        access = midiAccess;
        setStatus('ready');
        attach();
        midiAccess.onstatechange = attach;
      })
      .catch(() => {
        if (!cancelled) setStatus('denied');
      });

    return () => {
      cancelled = true;
      if (access) {
        access.onstatechange = null;
        access.inputs.forEach((input) => {
          input.onmidimessage = null;
        });
      }
    };
  }, [requested]);

  const connect = useCallback(() => setRequested(true), []);

  return { supported, status, devices, connect };
}
