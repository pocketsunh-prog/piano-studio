import { useCallback, useEffect, useState } from 'react';
import { PianoEngine } from '../audio/PianoEngine';

let engineSingleton: PianoEngine | null = null;

/** The app-wide piano engine (one AudioContext per page). */
export function getPianoEngine(): PianoEngine {
  if (!engineSingleton) {
    engineSingleton = new PianoEngine({ volume: 0.8, reverbMix: 0.24 });
  }
  return engineSingleton;
}

export interface PianoAudio {
  engine: PianoEngine;
  ready: boolean;
  enableAudio: () => Promise<void>;
  volume: number;
  setVolume: (value: number) => void;
  reverbMix: number;
  setReverbMix: (value: number) => void;
}

export function usePianoEngine(): PianoAudio {
  const engine = getPianoEngine();
  const [ready, setReady] = useState<boolean>(() => engine.state === 'running');
  const [volume, setVolume] = useState(0.8);
  const [reverbMix, setReverbMix] = useState(0.24);

  const enableAudio = useCallback(async () => {
    try {
      await engine.ensureStarted();
      setReady(engine.state === 'running');
    } catch (error) {
      console.error('Could not start audio', error);
    }
  }, [engine]);

  useEffect(() => {
    engine.setVolume(volume);
  }, [engine, volume]);

  useEffect(() => {
    engine.setReverbMix(reverbMix);
  }, [engine, reverbMix]);

  // Browsers only allow AudioContext to start inside a user gesture.
  useEffect(() => {
    if (ready) return;
    const unlock = () => {
      void enableAudio();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [ready, enableAudio]);

  // Playback or game views may start the engine directly; reflect that in the UI.
  useEffect(() => {
    if (ready) return;
    const timer = window.setInterval(() => {
      if (engine.state === 'running') setReady(true);
    }, 700);
    return () => window.clearInterval(timer);
  }, [engine, ready]);

  return { engine, ready, enableAudio, volume, setVolume, reverbMix, setReverbMix };
}
