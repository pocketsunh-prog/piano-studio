import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NoteEvent, Score } from '../music/types';
import type { PianoEngine } from '../audio/PianoEngine';
import {
  beatToSeconds,
  measureBeats,
  scoreDurationSeconds,
  secondsToBeat,
  timeSignatureAt,
} from '../music/timing';

export interface TimedNote extends NoteEvent {
  startSec: number;
  durationSec: number;
}

export interface PlaybackOptions {
  score: Score;
  engine: PianoEngine;
  tempoScale: number;
  loop: boolean;
  metronome: boolean;
}

export interface PlaybackPosition {
  beat: number;
  scoreSec: number;
  isPlaying: boolean;
}

const LOOKAHEAD_SEC = 0.9;
const SCHEDULE_INTERVAL_MS = 90;
const UI_INTERVAL_SEC = 1 / 30;

function lowerBound(notes: TimedNote[], scoreSec: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].startSec < scoreSec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function soundingAt(notes: TimedNote[], scoreSec: number, limit = 32): number[] {
  const result: number[] = [];
  for (const note of notes) {
    if (note.startSec > scoreSec) break;
    if (note.startSec + note.durationSec > scoreSec) {
      result.push(note.midi);
      if (result.length >= limit) break;
    }
  }
  return result;
}

/**
 * Transport + look-ahead scheduler. Schedules score notes into the piano engine
 * ~0.9 s ahead, drives a 30 fps UI clock, and supports seek/loop/tempo/metronome.
 */
export function usePlayback({ score, engine, tempoScale, loop, metronome }: PlaybackOptions) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(0);
  const [soundingMidis, setSoundingMidis] = useState<number[]>([]);

  const data = useMemo(() => {
    const timedNotes: TimedNote[] = score.notes
      .map((note) => {
        const startSec = beatToSeconds(score, note.start);
        const endSec = beatToSeconds(score, note.start + note.duration);
        return { ...note, startSec, durationSec: Math.max(0.02, endSec - startSec) };
      })
      .sort((a, b) => a.startSec - b.startSec);

    return {
      score,
      timedNotes,
      durationSec: scoreDurationSeconds(score),
      totalBeats: Math.max(score.lengthBeats, 0.001),
    };
  }, [score]);

  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const stateRef = useRef({
    playing: false,
    startCtx: 0,
    startBeat: 0,
    startScoreSec: 0,
    nextIndex: 0,
    nextClickBeat: 0,
    beat: 0,
    scoreSec: 0,
    tempoScale,
    loop,
    metronome,
    raf: 0,
    timer: 0,
    lastUiAt: 0,
  });

  const tickRef = useRef<() => void>(() => {});
  const frameRef = useRef<() => void>(() => {});

  const cancelTimers = useCallback(() => {
    const state = stateRef.current;
    if (state.raf) cancelAnimationFrame(state.raf);
    if (state.timer) window.clearInterval(state.timer);
    state.raf = 0;
    state.timer = 0;
  }, []);

  const anchor = useCallback(
    (beat: number) => {
      const state = stateRef.current;
      const current = dataRef.current;
      const safeBeat = Math.min(Math.max(0, beat), current.totalBeats);
      state.startBeat = safeBeat;
      state.beat = safeBeat;
      state.startScoreSec = beatToSeconds(current.score, safeBeat);
      state.scoreSec = state.startScoreSec;
      state.startCtx = engine.now() + 0.08;
      state.nextIndex = lowerBound(current.timedNotes, state.startScoreSec - 1e-6);
      state.nextClickBeat = Math.ceil(safeBeat - 1e-9);
      state.lastUiAt = 0;
      setCurrentBeat(safeBeat);
      setSoundingMidis([]);
    },
    [engine],
  );

  const tick = useCallback(() => {
    const state = stateRef.current;
    if (!state.playing) return;
    const current = dataRef.current;
    const engineNow = engine.now();
    const nowScoreSec = state.startScoreSec + Math.max(0, engineNow - state.startCtx) * state.tempoScale;
    const horizon = nowScoreSec + LOOKAHEAD_SEC;

    while (state.nextIndex < current.timedNotes.length) {
      const note = current.timedNotes[state.nextIndex];
      if (note.startSec > horizon) break;
      const when = state.startCtx + (note.startSec - state.startScoreSec) / state.tempoScale;
      if (when >= engineNow - 0.05) {
        engine.scheduleNote(
          note.midi,
          note.velocity,
          when,
          Math.max(0.03, note.durationSec / state.tempoScale),
        );
      }
      state.nextIndex += 1;
    }

    if (state.metronome) {
      let guard = 0;
      while (guard < 64) {
        const beat = state.nextClickBeat;
        if (beat > current.totalBeats + 1) break;
        const sec = beatToSeconds(current.score, beat);
        if (sec > horizon) break;
        if (sec >= state.startScoreSec - 1e-6) {
          const when = state.startCtx + (sec - state.startScoreSec) / state.tempoScale;
          const signature = timeSignatureAt(current.score, beat);
          const bar = measureBeats(signature);
          const accent = Math.abs(((beat % bar) + bar) % bar) < 1e-6;
          engine.metronomeClick(when, accent);
        }
        state.nextClickBeat = beat + 1;
        guard += 1;
      }
    }
  }, [engine]);
  tickRef.current = tick;

  const frame = useCallback(() => {
    const state = stateRef.current;
    if (!state.playing) return;
    const current = dataRef.current;
    const engineNow = engine.now();
    const scoreSec = state.startScoreSec + Math.max(0, engineNow - state.startCtx) * state.tempoScale;
    const beat = secondsToBeat(current.score, scoreSec);
    state.beat = beat;
    state.scoreSec = scoreSec;

    if (current.durationSec > 0 && scoreSec >= current.durationSec - 0.02) {
      if (state.loop) {
        engine.stopAll();
        anchor(0);
        tickRef.current();
        state.raf = requestAnimationFrame(() => frameRef.current());
        return;
      }
      state.playing = false;
      cancelTimers();
      engine.stopAll();
      setIsPlaying(false);
      setCurrentBeat(current.totalBeats);
      setSoundingMidis([]);
      state.beat = current.totalBeats;
      return;
    }

    if (engineNow - state.lastUiAt >= UI_INTERVAL_SEC) {
      state.lastUiAt = engineNow;
      setCurrentBeat(beat);
      setSoundingMidis(soundingAt(current.timedNotes, scoreSec));
    }
    state.raf = requestAnimationFrame(() => frameRef.current());
  }, [anchor, cancelTimers, engine]);
  frameRef.current = frame;

  const startTimers = useCallback(() => {
    const state = stateRef.current;
    state.timer = window.setInterval(() => tickRef.current(), SCHEDULE_INTERVAL_MS);
    state.raf = requestAnimationFrame(() => frameRef.current());
  }, []);

  const play = useCallback(async () => {
    const state = stateRef.current;
    if (state.playing) return;
    await engine.ensureStarted();
    const current = dataRef.current;
    if (!current.timedNotes.length) return;

    let startBeat = state.beat;
    if (startBeat >= current.totalBeats - 0.01) startBeat = 0;
    state.playing = true;
    anchor(startBeat);
    setIsPlaying(true);
    tickRef.current();
    startTimers();
  }, [anchor, engine, startTimers]);

  const pause = useCallback(() => {
    const state = stateRef.current;
    if (!state.playing) return;
    state.playing = false;
    cancelTimers();
    engine.stopAll();
    setIsPlaying(false);
    setSoundingMidis([]);
    setCurrentBeat(state.beat);
  }, [cancelTimers, engine]);

  const stop = useCallback(() => {
    const state = stateRef.current;
    state.playing = false;
    cancelTimers();
    engine.stopAll();
    state.beat = 0;
    state.scoreSec = 0;
    setIsPlaying(false);
    setCurrentBeat(0);
    setSoundingMidis([]);
  }, [cancelTimers, engine]);

  const seek = useCallback(
    (beat: number) => {
      const state = stateRef.current;
      const current = dataRef.current;
      if (state.playing) {
        engine.stopAll();
        anchor(beat);
        tickRef.current();
      } else {
        const safeBeat = Math.min(Math.max(0, beat), current.totalBeats);
        state.beat = safeBeat;
        state.scoreSec = beatToSeconds(current.score, safeBeat);
        setCurrentBeat(safeBeat);
        setSoundingMidis([]);
      }
    },
    [anchor, engine],
  );

  const getPosition = useCallback((): PlaybackPosition => {
    const state = stateRef.current;
    return { beat: state.beat, scoreSec: state.scoreSec, isPlaying: state.playing };
  }, []);

  // A different score resets the transport.
  useEffect(() => {
    const state = stateRef.current;
    state.playing = false;
    cancelTimers();
    engine.stopAll();
    state.beat = 0;
    state.scoreSec = 0;
    setIsPlaying(false);
    setCurrentBeat(0);
    setSoundingMidis([]);
  }, [score.id, cancelTimers, engine]);

  // Changing tempo mid-flight re-anchors the clock without stopping playback.
  useEffect(() => {
    const state = stateRef.current;
    const previous = state.tempoScale;
    state.tempoScale = tempoScale;
    if (previous !== tempoScale && state.playing) {
      engine.stopAll();
      anchor(state.beat);
      tickRef.current();
    }
  }, [tempoScale, anchor, engine]);

  useEffect(() => {
    stateRef.current.loop = loop;
  }, [loop]);

  useEffect(() => {
    stateRef.current.metronome = metronome;
  }, [metronome]);

  useEffect(
    () => () => {
      const state = stateRef.current;
      state.playing = false;
      cancelTimers();
      engine.stopAll();
    },
    [cancelTimers, engine],
  );

  return { isPlaying, currentBeat, soundingMidis, play, pause, stop, seek, getPosition };
}
