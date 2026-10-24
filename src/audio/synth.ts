/**
 * Shared additive piano synthesis.
 *
 * The live engine (`PianoEngine`) and the offline self-test (`selftest.ts`) use
 * exactly the same code path in this module, so what the self-test measures is
 * what the user hears.
 *
 * Signal design (per note):
 *  - additive partials with piano inharmonicity (stretched partials), a hammer
 *    strike-position comb, and a velocity/brightness dependent spectral tilt;
 *  - one detuned unison partner on the fundamental for natural string beating;
 *  - per-partial exponential decay, high partials decaying faster;
 *  - a short band-passed noise burst for the hammer attack;
 *  - stereo placement by pitch (bass slightly left, treble slightly right).
 *
 * Master bus: dry + generated convolution reverb -> gentle compressor ->
 * soft-clip limiter -> master volume. The voice level is chosen so that large
 * chords stay below full scale.
 */
import { MAX_PIANO_MIDI, MIN_PIANO_MIDI, midiToFrequency } from '../music/pitch';

/** Maximum number of simultaneously tracked voices (live + scheduled). */
export const MAX_VOICES = 64;
/** Wet gain applied per unit of reverb mix (0..1). */
export const REVERB_WET_SCALE = 0.75;
/** Default reverb length in seconds. */
export const REVERB_SECONDS = 2.3;

const DEFAULT_SAMPLE_RATE = 44100;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Deterministic value in [0, 1) from an integer seed. */
function hashUnit(seed: number): number {
  let x = seed | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Small deterministic PRNG (mulberry32) used for reverb / noise generation. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Musical shaping helpers (pure, unit-testable)
 * ------------------------------------------------------------------ */

export interface PartialSpec {
  /** 1-based partial number. */
  readonly harmonic: number;
  /** Inharmonic partial frequency in Hz. */
  readonly frequency: number;
  /** Relative amplitude, normalized so the partials sum to 1. */
  readonly amplitude: number;
  /** Seconds for the partial to fall by ~60 dB. */
  readonly decay: number;
  /** Magnitude of the unison detune in cents (fundamental only). */
  readonly detuneCents: number;
}

export interface PianoSpectrum {
  readonly midi: number;
  readonly fundamental: number;
  /** Piano inharmonicity coefficient B. */
  readonly inharmonicity: number;
  /** Attack time in seconds. */
  readonly attack: number;
  /** Natural (un-damped) decay time in seconds. */
  readonly naturalDecay: number;
  readonly partials: PartialSpec[];
}

/** Piano strings are stiffer (more inharmonic) in the bass and the extreme treble. */
export function inharmonicityForMidi(midi: number): number {
  const m = clamp(Math.round(finiteOr(midi, 60)), MIN_PIANO_MIDI, MAX_PIANO_MIDI);
  if (m < 60) return 0.00011 + 0.00052 * Math.pow((60 - m) / 39, 1.35);
  return 0.00011 + 0.00034 * Math.pow((m - 60) / 48, 1.4);
}

/** Natural decay time of the fundamental: long in the bass, short in the treble. */
export function naturalDecayForMidi(midi: number): number {
  const m = clamp(Math.round(finiteOr(midi, 60)), MIN_PIANO_MIDI, MAX_PIANO_MIDI);
  return clamp(9.2 * Math.pow(2, -(m - 21) / 31), 1.1, 10.5);
}

/** Time constant (seconds) of the damper when a key is released. */
export function dampTauForMidi(midi: number): number {
  const m = clamp(Math.round(finiteOr(midi, 60)), MIN_PIANO_MIDI, MAX_PIANO_MIDI);
  return clamp(0.3 * Math.pow(2, -(m - 21) / 46), 0.055, 0.32);
}

/** Stereo position for a key: bass a little left, treble a little right. */
export function panForMidi(midi: number): number {
  const m = clamp(Math.round(finiteOr(midi, 60)), MIN_PIANO_MIDI, MAX_PIANO_MIDI);
  return clamp(((m - 60) / 45) * 0.55, -0.6, 0.6);
}

/**
 * Builds the additive spectrum for one key. Pure maths, no Web Audio, so it can
 * be unit-tested directly.
 */
export function computePianoSpectrum(
  midi: number,
  velocity: number,
  brightness: number,
  sampleRate: number,
): PianoSpectrum {
  const m = clamp(Math.round(finiteOr(midi, 60)), MIN_PIANO_MIDI, MAX_PIANO_MIDI);
  const vel = clamp(finiteOr(velocity, 90) / 127, 0.01, 1);
  const bright = clamp01(finiteOr(brightness, 0.5));
  const fundamental = midiToFrequency(m);
  const inharmonicity = inharmonicityForMidi(m);
  const naturalDecay = naturalDecayForMidi(m);
  const rate = finiteOr(sampleRate, DEFAULT_SAMPLE_RATE) > 0 ? sampleRate : DEFAULT_SAMPLE_RATE;
  const nyquistLimit = Math.min(rate * 0.45, 16000);

  // Softer / mellow playing rolls the highs off much faster.
  const tilt = Math.max(1.05, 2.55 - 1.15 * vel - 0.8 * bright);
  const maxPartials = m < 36 ? 14 : m < 60 ? 11 : m < 84 ? 8 : 6;
  const strikeRatio = 1 / 7.5; // hammer strikes ~1/7.5 of the string length
  const beatCents = m < 72 ? 2.4 : 1.3;

  const partials: PartialSpec[] = [];
  let total = 0;

  for (let harmonic = 1; harmonic <= maxPartials; harmonic += 1) {
    const frequency = harmonic * fundamental * Math.sqrt(1 + inharmonicity * harmonic * harmonic);
    if (!Number.isFinite(frequency) || frequency >= nyquistLimit) break;

    const strikeComb = 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * harmonic * strikeRatio));
    const weight = 0.7 + 0.6 * hashUnit(m * 97 + harmonic * 13 + 5);
    const air = Math.exp(-frequency / 11000);
    const amplitude = Math.pow(harmonic, -tilt) * strikeComb * weight * air;
    if (!Number.isFinite(amplitude) || amplitude <= 0) continue;

    const decay = Math.max(0.3, naturalDecay * Math.pow(harmonic, -0.72) * (0.9 + 0.2 * vel));
    const detuneCents =
      harmonic === 1
        ? beatCents * (0.8 + 0.4 * hashUnit(m * 11 + 3))
        : (hashUnit(m * 7 + harmonic * 3) - 0.5) * 1.4;

    partials.push({ harmonic, frequency, amplitude, decay, detuneCents });
    total += amplitude;
  }

  // Extremely high notes can push every partial past the limit; keep the fundamental.
  if (partials.length === 0) {
    partials.push({ harmonic: 1, frequency: fundamental, amplitude: 1, decay: naturalDecay, detuneCents: beatCents });
    total = 1;
  }

  const normalized = partials.map((partial) => ({
    ...partial,
    amplitude: partial.amplitude / total,
  }));

  const attack = Math.min(0.02, Math.max(0.002, 0.0025 + 0.006 * Math.pow(1 - vel, 1.6)));

  return { midi: m, fundamental, inharmonicity, attack, naturalDecay, partials: normalized };
}

/* ------------------------------------------------------------------ *
 * Buffers
 * ------------------------------------------------------------------ */

/** Generated stereo impulse response for the convolution reverb. */
export function createImpulseResponse(ctx: BaseAudioContext, seconds = REVERB_SECONDS): AudioBuffer {
  const lengthSeconds = clamp(finiteOr(seconds, REVERB_SECONDS), 0.2, 8);
  const sampleRate = finiteOr(ctx.sampleRate, DEFAULT_SAMPLE_RATE);
  const length = Math.max(128, Math.floor(sampleRate * lengthSeconds));
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const decayConstant = lengthSeconds * 0.3;
  const tapTimes = [0.0071, 0.0127, 0.0193, 0.0311, 0.0467, 0.0673, 0.0919];

  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    const random = mulberry32((channel === 0 ? 0x1a2b3c4d : 0x5e6f7a8b) ^ 0x9e3779b9);
    let low1 = 0;
    let low2 = 0;

    // Darkening diffuse tail: low-passed noise with an exponential envelope.
    for (let i = 0; i < length; i += 1) {
      const t = i / sampleRate;
      const noise = random() * 2 - 1;
      const cutoff = clamp(0.62 - 0.47 * (t / lengthSeconds), 0.1, 0.7);
      low1 += (noise - low1) * cutoff;
      low2 += (low1 - low2) * cutoff;
      const tail = Math.exp(-t / decayConstant) * Math.max(0, 1 - t / lengthSeconds);
      data[i] = low2 * tail * 0.85;
    }

    // Sparse early reflections give the tail a room-like onset.
    for (let tap = 0; tap < tapTimes.length; tap += 1) {
      const tapTime = tapTimes[tap] + channel * 0.0013;
      const index = Math.floor(tapTime * sampleRate);
      if (index >= length) continue;
      const sign = random() < 0.5 ? -1 : 1;
      const gain = sign * (0.55 - 0.4 * (tap / tapTimes.length)) * Math.exp(-tapTimes[tap] * 2.2);
      data[index] += gain;
    }
  }

  // Keep the buffer peak sane; the convolver additionally normalizes by energy.
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const magnitude = Math.abs(data[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }
  if (peak > 0) {
    const scale = 0.8 / peak;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) data[i] *= scale;
    }
  }

  return buffer;
}

/** Short mono noise buffer used for the hammer attack transient. */
export function createNoiseBuffer(ctx: BaseAudioContext, seconds = 0.3): AudioBuffer {
  const lengthSeconds = clamp(finiteOr(seconds, 0.3), 0.02, 2);
  const sampleRate = finiteOr(ctx.sampleRate, DEFAULT_SAMPLE_RATE);
  const length = Math.max(64, Math.floor(sampleRate * lengthSeconds));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const random = mulberry32(0x51ed270b);
  for (let i = 0; i < length; i += 1) data[i] = (random() * 2 - 1) * (1 - (0.5 * i) / length);
  return buffer;
}

/* ------------------------------------------------------------------ *
 * Master bus
 * ------------------------------------------------------------------ */

export interface MasterChainOptions {
  /** Master volume 0..1. Defaults to 0.8. */
  readonly volume?: number;
  /** Reverb mix 0..1. Defaults to 0.22. */
  readonly reverbMix?: number;
}

export interface MasterChain {
  /** Voices connect their output here (dry + reverb). */
  readonly input: GainNode;
  /** Dry-only input for the metronome click. */
  readonly dryInput: GainNode;
  /** Pass-through analyser on the final output (null when unsupported, e.g. in mocks). */
  readonly analyser: AnalyserNode | null;
  setVolume(value: number): void;
  setReverbMix(value: number): void;
  dispose(): void;
}

/** Soft-clip curve: identity below 0.7, then a smooth tanh approach to 1.0. */
export function createSoftClipCurve(size = 2048): Float32Array<ArrayBuffer> {
  const points = Math.max(64, Math.floor(size));
  const curve = new Float32Array(points);
  const knee = 0.7;
  for (let i = 0; i < points; i += 1) {
    const x = (i / (points - 1)) * 2 - 1;
    const magnitude = Math.abs(x);
    if (magnitude <= knee) {
      curve[i] = x;
    } else {
      const compressed = knee + (1 - knee) * Math.tanh((magnitude - knee) / (1 - knee));
      curve[i] = x < 0 ? -compressed : compressed;
    }
  }
  return curve;
}

/**
 * Builds the master bus: dry + generated convolution reverb, gentle compressor,
 * soft-clip limiter and master volume. Works with `AudioContext` and
 * `OfflineAudioContext` alike.
 */
export function createMasterChain(ctx: BaseAudioContext, options: MasterChainOptions = {}): MasterChain {
  const volume = clamp01(finiteOr(options.volume, 0.8));
  const reverbMix = clamp01(finiteOr(options.reverbMix, 0.22));

  const input = ctx.createGain();
  input.gain.value = 1;
  const dryInput = ctx.createGain();
  dryInput.gain.value = 1;
  const dry = ctx.createGain();
  dry.gain.value = 1;
  const reverbSend = ctx.createGain();
  reverbSend.gain.value = 1;
  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  convolver.buffer = createImpulseResponse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = reverbMix * REVERB_WET_SCALE;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -10;
  compressor.knee.value = 24;
  compressor.ratio.value = 3.2;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.24;
  const limiter = ctx.createWaveShaper();
  limiter.curve = createSoftClipCurve();
  limiter.oversample = '2x';
  const master = ctx.createGain();
  master.gain.value = volume;

  input.connect(dry);
  dryInput.connect(dry);
  dry.connect(compressor);
  input.connect(reverbSend);
  reverbSend.connect(convolver);
  convolver.connect(wet);
  wet.connect(compressor);
  compressor.connect(limiter);
  limiter.connect(master);

  // Insert a pass-through analyser on the master output so the UI can show a
  // live level meter. Environments without AnalyserNode (test mocks) fall back
  // to a direct connection.
  let analyser: AnalyserNode | null = null;
  try {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.55;
    master.connect(analyser);
    analyser.connect(ctx.destination);
  } catch {
    analyser = null;
    master.connect(ctx.destination);
  }

  const nodes: AudioNode[] = [
    input,
    dryInput,
    dry,
    reverbSend,
    convolver,
    wet,
    compressor,
    limiter,
    master,
  ];
  if (analyser) nodes.push(analyser);

  let currentVolume = volume;
  let currentReverbMix = reverbMix;

  return {
    input,
    dryInput,
    analyser,
    setVolume(value: number): void {
      currentVolume = clamp01(Number.isFinite(value) ? value : currentVolume);
      master.gain.setTargetAtTime(currentVolume, ctx.currentTime, 0.02);
    },
    setReverbMix(value: number): void {
      currentReverbMix = clamp01(Number.isFinite(value) ? value : currentReverbMix);
      wet.gain.setTargetAtTime(currentReverbMix * REVERB_WET_SCALE, ctx.currentTime, 0.03);
    },
    dispose(): void {
      for (const node of nodes) {
        try {
          node.disconnect();
        } catch {
          // Already disconnected / context closed.
        }
      }
      convolver.buffer = null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Voices
 * ------------------------------------------------------------------ */

export interface PianoVoiceParams {
  readonly midi: number;
  /** 1..127 MIDI velocity. */
  readonly velocity: number;
  /** 0..1 timbre control (0 = mellow, 1 = bright). */
  readonly brightness: number;
  /** Absolute AudioContext time of the attack. */
  readonly when: number;
  readonly sampleRate: number;
  /** Shared hammer noise buffer (see `createNoiseBuffer`). */
  readonly noiseBuffer: AudioBuffer;
}

export interface PianoVoice {
  readonly midi: number;
  /** Absolute time of the attack. */
  readonly startTime: number;
  /** Time the voice would go silent without any damping. */
  readonly naturalEndTime: number;
  readonly released: boolean;
  /** Stereo output; connect it to the master chain input. */
  readonly output: AudioNode;
  readonly nodes: readonly AudioNode[];
  /** Applies the damper from `when` (seconds, absolute AudioContext time). */
  release(when: number): void;
  /** Fast fade for note stealing / transport stop. */
  stopNow(when: number): void;
  /** True once the voice can no longer produce sound at `time`. */
  isSilentAt(time: number): boolean;
  /** Hard disconnect of every node. */
  dispose(): void;
}

function holdParam(param: AudioParam, at: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(at);
  else param.cancelScheduledValues(at);
}

/**
 * Builds one piano note. The returned voice is not connected to anything; the
 * caller connects `output` to the master chain.
 */
export function createPianoVoice(
  ctx: BaseAudioContext,
  params: PianoVoiceParams,
  onEnded?: () => void,
): PianoVoice {
  const midi = clamp(Math.round(finiteOr(params.midi, 60)), MIN_PIANO_MIDI, MAX_PIANO_MIDI);
  const velocity = clamp(finiteOr(params.velocity, 90), 1, 127);
  const brightness = clamp01(finiteOr(params.brightness, 0.5));
  const sampleRate =
    finiteOr(params.sampleRate, DEFAULT_SAMPLE_RATE) > 0 ? params.sampleRate : DEFAULT_SAMPLE_RATE;
  const startTime = Math.max(0, finiteOr(params.when, 0));
  const spectrum = computePianoSpectrum(midi, velocity, brightness, sampleRate);
  const velocity01 = velocity / 127;
  const releaseTau = dampTauForMidi(midi);

  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(panForMidi(midi) + (hashUnit(midi * 3 + 1) - 0.5) * 0.04, -0.85, 0.85);

  const voiceGain = ctx.createGain();
  voiceGain.gain.value = 0.4 * Math.pow(velocity01, 1.35);
  voiceGain.connect(panner);

  const nodes: AudioNode[] = [panner, voiceGain];
  const oscillators: OscillatorNode[] = [];
  const naturalStops: Array<{ readonly oscillator: OscillatorNode; readonly at: number }> = [];
  let remainingOscillators = 0;
  let cleaned = false;
  let releasedAt: number | null = null;
  let stoppedAt: number | null = null;
  let naturalEnd = startTime + spectrum.attack;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    if (onEnded) onEnded();
  };

  const noteEnded = (): void => {
    remainingOscillators -= 1;
    if (remainingOscillators <= 0) cleanup();
  };

  const shapeEnvelope = (
    gain: GainNode,
    amplitude: number,
    attack: number,
    decay: number,
    attackAt: number,
  ): number => {
    const peakAt = attackAt + attack;
    const decayEnd = peakAt + decay;
    gain.gain.setValueAtTime(0, attackAt);
    gain.gain.linearRampToValueAtTime(amplitude, peakAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(1e-6, amplitude * 0.001), decayEnd);
    gain.gain.linearRampToValueAtTime(0, decayEnd + 0.02);
    return decayEnd + 0.04;
  };

  // Additive partial stack.
  for (const partial of spectrum.partials) {
    const oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = partial.frequency;
    oscillator.detune.value = partial.detuneCents;
    const gain = ctx.createGain();
    const stopAt = shapeEnvelope(gain, partial.amplitude, spectrum.attack, partial.decay, startTime);
    oscillator.connect(gain);
    gain.connect(voiceGain);
    oscillator.start(startTime);
    oscillator.stop(stopAt);
    oscillator.onended = noteEnded;
    oscillators.push(oscillator);
    naturalStops.push({ oscillator, at: stopAt });
    nodes.push(oscillator, gain);
    remainingOscillators += 1;
    naturalEnd = Math.max(naturalEnd, stopAt);

    // The fundamental is a pair of slightly detuned strings -> slow beating.
    if (partial.harmonic === 1) {
      const unison = ctx.createOscillator();
      unison.type = 'sine';
      unison.frequency.value = partial.frequency;
      unison.detune.value = -partial.detuneCents;
      const unisonGain = ctx.createGain();
      const unisonStop = shapeEnvelope(
        unisonGain,
        partial.amplitude * 0.45,
        spectrum.attack,
        partial.decay,
        startTime,
      );
      unison.connect(unisonGain);
      unisonGain.connect(voiceGain);
      unison.start(startTime);
      unison.stop(unisonStop);
      unison.onended = noteEnded;
      oscillators.push(unison);
      naturalStops.push({ oscillator: unison, at: unisonStop });
      nodes.push(unison, unisonGain);
      remainingOscillators += 1;
      naturalEnd = Math.max(naturalEnd, unisonStop);
    }
  }

  // Hammer attack: a very short band-passed noise burst.
  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = params.noiseBuffer;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = clamp(spectrum.fundamental * 3 + 700, 500, 6500);
  noiseFilter.Q.value = 0.9;
  const noiseGain = ctx.createGain();
  const noisePeak = 0.22 * Math.pow(velocity01, 1.5);
  const noiseStart = startTime + Math.max(0.0005, spectrum.attack * 0.25);
  const noiseDecay = 0.016 + 0.018 * (1 - velocity01);
  noiseGain.gain.setValueAtTime(0, noiseStart);
  noiseGain.gain.linearRampToValueAtTime(noisePeak, noiseStart + 0.0015);
  noiseGain.gain.exponentialRampToValueAtTime(Math.max(1e-6, noisePeak * 0.001), noiseStart + noiseDecay);
  noiseGain.gain.linearRampToValueAtTime(0, noiseStart + noiseDecay + 0.01);
  noiseSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(voiceGain);
  noiseSource.start(noiseStart);
  noiseSource.stop(noiseStart + noiseDecay + 0.03);
  nodes.push(noiseSource, noiseFilter, noiseGain);

  const stopOscillators = (at: number): void => {
    // Never extend an oscillator beyond its natural stop: the envelope is
    // already silent there, and extending would keep the node alive needlessly.
    for (const entry of naturalStops) {
      try {
        entry.oscillator.stop(Math.min(at, entry.at));
      } catch {
        // Already stopped.
      }
    }
  };

  const release = (when: number): void => {
    if (releasedAt !== null) return;
    const at = Math.max(finiteOr(when, startTime), startTime);
    releasedAt = at;
    if (at >= naturalEnd) return; // Already decayed naturally.
    holdParam(voiceGain.gain, at);
    voiceGain.gain.setTargetAtTime(0, at, releaseTau);
    stopOscillators(at + releaseTau * 6 + 0.03);
  };

  const stopNow = (when: number): void => {
    if (stoppedAt !== null) return;
    const at = Math.max(finiteOr(when, startTime), 0);
    stoppedAt = at;
    if (at < startTime - 0.001) {
      // Never audible: free everything at once, there is nothing to click.
      for (const oscillator of oscillators) {
        try {
          oscillator.stop(at);
        } catch {
          // Already stopped.
        }
      }
      cleanup();
      return;
    }
    if (releasedAt === null) releasedAt = at;
    holdParam(voiceGain.gain, at);
    voiceGain.gain.setTargetAtTime(0, at, 0.004);
    voiceGain.gain.setValueAtTime(0, at + 0.03);
    stopOscillators(at + 0.04);
  };

  const isSilentAt = (time: number): boolean => {
    if (stoppedAt !== null && time >= stoppedAt + 0.05) return true;
    if (releasedAt !== null && time >= releasedAt + releaseTau * 6 + 0.05) return true;
    return time >= naturalEnd + 0.001;
  };

  return {
    midi,
    startTime,
    naturalEndTime: naturalEnd,
    get released(): boolean {
      return releasedAt !== null;
    },
    output: panner,
    nodes,
    release,
    stopNow,
    isSilentAt,
    dispose(): void {
      if (stoppedAt === null) stoppedAt = startTime;
      for (const oscillator of oscillators) {
        try {
          oscillator.stop(startTime);
        } catch {
          // Already stopped.
        }
      }
      cleanup();
    },
  };
}
