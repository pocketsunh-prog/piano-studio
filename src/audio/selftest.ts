/**
 * Offline audio self-test.
 *
 * Renders a handful of notes/chords through `OfflineAudioContext` using the
 * exact same synthesis code path as the live engine, and reports signal levels.
 * It is meant to be called from a real browser (the Lead exposes it as
 * `window.__pianoAudioTest`); it is importable but guarded in environments that
 * have no Web Audio (e.g. jsdom), where it rejects with a clear error.
 */
import {
  createMasterChain,
  createNoiseBuffer,
  createPianoVoice,
} from './synth';

export interface AudioSelfTestResult {
  name: string;
  peak: number;
  rms: number;
  durationSec: number;
  sampleRate: number;
}

interface SelfTestItem {
  readonly name: string;
  readonly midis: readonly number[];
  readonly velocity: number;
}

interface OfflineContextConstructor {
  new (numberOfChannels: number, length: number, sampleRate: number): OfflineAudioContext;
}

const ITEMS: readonly SelfTestItem[] = [
  { name: 'C4', midis: [60], velocity: 96 },
  { name: 'E4', midis: [64], velocity: 92 },
  { name: 'G4', midis: [67], velocity: 92 },
  { name: 'C5', midis: [72], velocity: 100 },
  { name: 'C major chord', midis: [60, 64, 67, 72], velocity: 88 },
];

const SAMPLE_RATE = 44100;
const RENDER_SECONDS = 2.4;
const NOTE_START = 0.04;
const NOTE_HOLD = 0.9;

interface OfflineContextGlobal {
  OfflineAudioContext?: OfflineContextConstructor;
  webkitOfflineAudioContext?: OfflineContextConstructor;
}

/** Returns a constructor for OfflineAudioContext, or null when unavailable. */
export function getOfflineAudioContextConstructor(): OfflineContextConstructor | null {
  const scope = globalThis as unknown as OfflineContextGlobal;
  if (typeof scope.OfflineAudioContext === 'function') return scope.OfflineAudioContext;
  if (typeof scope.webkitOfflineAudioContext === 'function') return scope.webkitOfflineAudioContext;
  return null;
}

function analyse(buffer: AudioBuffer, name: string): AudioSelfTestResult {
  let peak = 0;
  let sumSquares = 0;
  let samples = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const value = data[i];
      if (!Number.isFinite(value)) continue;
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
      sumSquares += value * value;
      samples += 1;
    }
  }
  return {
    name,
    peak,
    rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0,
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
  };
}

async function renderItem(Constructor: OfflineContextConstructor, item: SelfTestItem): Promise<AudioSelfTestResult> {
  const length = Math.ceil(RENDER_SECONDS * SAMPLE_RATE);
  const offline = new Constructor(2, length, SAMPLE_RATE);
  const chain = createMasterChain(offline, { volume: 0.8, reverbMix: 0.22 });
  const noiseBuffer = createNoiseBuffer(offline);

  for (const midi of item.midis) {
    const voice = createPianoVoice(offline, {
      midi,
      velocity: item.velocity,
      brightness: 0.5,
      when: NOTE_START,
      sampleRate: SAMPLE_RATE,
      noiseBuffer,
    });
    voice.output.connect(chain.input);
    voice.release(NOTE_START + NOTE_HOLD);
  }

  const rendered = await offline.startRendering();
  chain.dispose();
  return analyse(rendered, item.name);
}

/**
 * Renders C4, E4, G4, C5 and a C major chord, returning the peak/RMS level of
 * each. Every peak must be > 0.02 when audio output works.
 */
export async function runAudioSelfTest(): Promise<AudioSelfTestResult[]> {
  const Constructor = getOfflineAudioContextConstructor();
  if (!Constructor) {
    throw new Error(
      'runAudioSelfTest requires OfflineAudioContext, which is not available in this environment.',
    );
  }
  const results: AudioSelfTestResult[] = [];
  for (const item of ITEMS) {
    results.push(await renderItem(Constructor, item));
  }
  return results;
}
