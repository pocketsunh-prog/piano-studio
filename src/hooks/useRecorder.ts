import { useCallback, useEffect, useRef, useState } from 'react';
import type { PianoEngine } from '../audio/PianoEngine';

export interface RecordedNote {
  midi: number;
  velocity: number;
  startMs: number;
  endMs: number;
}

export interface Recorder {
  recording: boolean;
  elapsedMs: number;
  start: (engine: PianoEngine) => Promise<void>;
  stop: () => void;
  cancel: () => void;
  noteOn: (midi: number, velocity: number) => void;
  noteOff: (midi: number) => void;
}

/** Captures live playing into timed note events for sheet export. */
export function useRecorder(onFinish: (notes: RecordedNote[], durationMs: number) => void): Recorder {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  const stateRef = useRef({
    recording: false,
    startedAt: 0,
    timer: 0,
    active: new Map<number, { startMs: number; velocity: number }>(),
    notes: [] as RecordedNote[],
  });

  const closeActive = useCallback((now: number) => {
    const state = stateRef.current;
    for (const [midi, active] of state.active) {
      state.notes.push({
        midi,
        velocity: active.velocity,
        startMs: Math.max(0, active.startMs - state.startedAt),
        endMs: Math.max(0, now - state.startedAt),
      });
    }
    state.active.clear();
  }, []);

  const start = useCallback(async (engine: PianoEngine) => {
    await engine.ensureStarted();
    const state = stateRef.current;
    state.recording = true;
    state.startedAt = performance.now();
    state.active.clear();
    state.notes = [];
    setRecording(true);
    setElapsedMs(0);
    window.clearInterval(state.timer);
    state.timer = window.setInterval(() => {
      setElapsedMs(performance.now() - state.startedAt);
    }, 100);
  }, []);

  const stop = useCallback(() => {
    const state = stateRef.current;
    if (!state.recording) return;
    const now = performance.now();
    closeActive(now);
    state.recording = false;
    window.clearInterval(state.timer);
    setRecording(false);
    const notes = state.notes.slice();
    const duration = now - state.startedAt;
    state.notes = [];
    finishRef.current(notes, duration);
  }, [closeActive]);

  const cancel = useCallback(() => {
    const state = stateRef.current;
    state.recording = false;
    window.clearInterval(state.timer);
    state.active.clear();
    state.notes = [];
    setRecording(false);
    setElapsedMs(0);
  }, []);

  const noteOn = useCallback((midi: number, velocity: number) => {
    const state = stateRef.current;
    if (!state.recording || state.active.has(midi)) return;
    state.active.set(midi, { startMs: performance.now(), velocity });
  }, []);

  const noteOff = useCallback((midi: number) => {
    const state = stateRef.current;
    if (!state.recording) return;
    const active = state.active.get(midi);
    if (!active) return;
    state.active.delete(midi);
    state.notes.push({
      midi,
      velocity: active.velocity,
      startMs: Math.max(0, active.startMs - state.startedAt),
      endMs: Math.max(0, performance.now() - state.startedAt),
    });
  }, []);

  useEffect(() => {
    const state = stateRef.current;
    return () => {
      window.clearInterval(state.timer);
      state.recording = false;
    };
  }, []);

  return { recording, elapsedMs, start, stop, cancel, noteOn, noteOff };
}
