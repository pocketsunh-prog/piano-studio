import { describe, expect, it } from 'vitest';
import {
  MAX_VOICES,
  REVERB_WET_SCALE,
  computePianoSpectrum,
  createImpulseResponse,
  createMasterChain,
  createNoiseBuffer,
  createPianoVoice,
  createSoftClipCurve,
  dampTauForMidi,
  inharmonicityForMidi,
  naturalDecayForMidi,
  panForMidi,
} from './synth';
import {
  MockAudioContext,
  MockConvolverNode,
  MockNode,
  findStaticGain,
} from './testing/mockAudioContext';

interface MockContextPair {
  readonly mock: MockAudioContext;
  readonly ctx: BaseAudioContext;
}

function makeMockContext(): MockContextPair {
  const mock = new MockAudioContext();
  return { mock, ctx: mock as unknown as BaseAudioContext };
}

function amplitudeAbove(spectrum: ReturnType<typeof computePianoSpectrum>, lowestHarmonic: number): number {
  return spectrum.partials
    .filter((partial) => partial.harmonic >= lowestHarmonic)
    .reduce((total, partial) => total + partial.amplitude, 0);
}

function highToLowRatio(velocity: number, brightness: number): number {
  const spectrum = computePianoSpectrum(60, velocity, brightness, 44100);
  const high = amplitudeAbove(spectrum, 5);
  const low = Math.max(1e-9, amplitudeAbove(spectrum, 1) - high);
  return high / low;
}

describe('computePianoSpectrum', () => {
  it('builds a normalized, sorted, inharmonic partial stack for C4', () => {
    const spectrum = computePianoSpectrum(60, 96, 0.5, 44100);
    expect(spectrum.midi).toBe(60);
    expect(spectrum.fundamental).toBeCloseTo(261.626, 2);
    expect(spectrum.partials.length).toBeGreaterThanOrEqual(6);

    const total = spectrum.partials.reduce((sum, partial) => sum + partial.amplitude, 0);
    expect(total).toBeCloseTo(1, 6);

    for (let i = 0; i < spectrum.partials.length; i += 1) {
      const partial = spectrum.partials[i];
      expect(partial.amplitude).toBeGreaterThan(0);
      expect(partial.frequency).toBeGreaterThan(0);
      if (i > 0) {
        expect(partial.frequency).toBeGreaterThan(spectrum.partials[i - 1].frequency);
        expect(partial.decay).toBeLessThan(spectrum.partials[i - 1].decay);
      }
    }

    // Piano strings stretch the partials slightly sharp.
    expect(spectrum.partials[1].frequency).toBeGreaterThan(2 * spectrum.fundamental);
    expect(spectrum.partials[1].frequency / (2 * spectrum.fundamental)).toBeLessThan(1.002);
  });

  it('gets brighter with velocity and with the brightness option', () => {
    expect(highToLowRatio(120, 0.5)).toBeGreaterThan(highToLowRatio(20, 0.5));
    expect(highToLowRatio(96, 0.9)).toBeGreaterThan(highToLowRatio(96, 0.1));
  });

  it('keeps every partial below the Nyquist guard', () => {
    const sampleRate = 8000;
    const spectrum = computePianoSpectrum(84, 100, 0.5, sampleRate);
    expect(spectrum.partials.length).toBeGreaterThan(0);
    for (const partial of spectrum.partials) {
      expect(partial.frequency).toBeLessThan(sampleRate * 0.45);
    }
  });

  it('is more inharmonic in the bass than in the middle', () => {
    expect(inharmonicityForMidi(21)).toBeGreaterThan(inharmonicityForMidi(60));
    expect(inharmonicityForMidi(108)).toBeGreaterThan(inharmonicityForMidi(60));
  });

  it('decays and damps faster as pitch rises', () => {
    expect(naturalDecayForMidi(21)).toBeGreaterThan(naturalDecayForMidi(60));
    expect(naturalDecayForMidi(60)).toBeGreaterThan(naturalDecayForMidi(108));
    expect(dampTauForMidi(21)).toBeGreaterThan(dampTauForMidi(60));
    expect(dampTauForMidi(60)).toBeGreaterThan(dampTauForMidi(108));
    expect(dampTauForMidi(108)).toBeGreaterThan(0);
  });

  it('spreads the keyboard across the stereo field', () => {
    expect(panForMidi(21)).toBeLessThan(0);
    expect(panForMidi(60)).toBe(0);
    expect(panForMidi(108)).toBeGreaterThan(0);
    expect(Math.abs(panForMidi(21))).toBeLessThanOrEqual(0.6);
    expect(Math.abs(panForMidi(108))).toBeLessThanOrEqual(0.6);
  });
});

describe('buffer generation', () => {
  it('generates a decaying stereo impulse response', () => {
    const { ctx } = makeMockContext();
    const buffer = createImpulseResponse(ctx, 1);
    expect(buffer.numberOfChannels).toBe(2);
    expect(buffer.length).toBe(44100);
    expect(buffer.duration).toBeCloseTo(1, 2);

    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const quarter = Math.floor(left.length / 4);
    const rms = (data: Float32Array, from: number, to: number): number => {
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, to - from));
    };

    expect(rms(left, 0, quarter)).toBeGreaterThan(0);
    expect(rms(left, 0, quarter)).toBeGreaterThan(rms(left, left.length - quarter, left.length) * 4);
    // Decorrelated channels give the reverb a stereo image.
    let difference = 0;
    for (let i = 0; i < left.length; i += 97) difference += Math.abs(left[i] - right[i]);
    expect(difference).toBeGreaterThan(0);
  });

  it('generates a usable hammer noise buffer', () => {
    const { mock, ctx } = makeMockContext();
    const buffer = createNoiseBuffer(ctx);
    expect(buffer.numberOfChannels).toBe(1);
    expect(buffer.length).toBe(Math.floor(mock.sampleRate * 0.3));
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(1);
  });

  it('soft clip curve is monotonic, bounded and linear at low level', () => {
    const curve = createSoftClipCurve(1025);
    expect(curve).toHaveLength(1025);
    for (let i = 0; i < curve.length; i += 1) {
      expect(curve[i]).toBeGreaterThanOrEqual(-1);
      expect(curve[i]).toBeLessThanOrEqual(1);
      if (i > 0) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
    }
    const midpoint = Math.floor((curve.length - 1) / 2);
    expect(curve[midpoint]).toBeCloseTo(0, 5);
    // The loud end is compressed below full scale.
    expect(curve[curve.length - 1]).toBeLessThan(1);
    expect(curve[curve.length - 1]).toBeGreaterThan(0.8);
  });

  it('builds a master chain with reverb and volume control', () => {
    const { mock, ctx } = makeMockContext();
    const chain = createMasterChain(ctx, { volume: 0.8, reverbMix: 0.22 });

    const convolver = mock.nodes.find((node): node is MockConvolverNode => node instanceof MockConvolverNode);
    expect(convolver).toBeDefined();
    expect(convolver?.buffer).not.toBeNull();
    expect(convolver?.normalize).toBe(true);

    const master = findStaticGain(mock, 0.8);
    const wet = findStaticGain(mock, 0.22 * REVERB_WET_SCALE);
    if (!master || !wet) throw new Error('master chain gains not found');

    chain.setVolume(0.25);
    expect(master.gain.eventsOf('setTargetAtTime').some((event) => event.value === 0.25)).toBe(true);
    chain.setReverbMix(0.5);
    expect(wet.gain.eventsOf('setTargetAtTime').some((event) => event.value === 0.5 * REVERB_WET_SCALE)).toBe(
      true,
    );

    chain.dispose();
    expect(mock.nodes.some((node) => node.disconnected)).toBe(true);
    expect(convolver?.buffer).toBeNull();
  });
});

describe('createPianoVoice', () => {
  const params = {
    midi: 60,
    velocity: 100,
    brightness: 0.5,
    when: 0.1,
    sampleRate: 44100,
  } as const;

  it('creates oscillators, envelopes and a hammer transient, then cleans up', () => {
    const { mock, ctx } = makeMockContext();
    const noiseBuffer = createNoiseBuffer(ctx);
    let ended = 0;
    const voice = createPianoVoice(ctx, { ...params, noiseBuffer }, () => {
      ended += 1;
    });

    const spectrum = computePianoSpectrum(params.midi, params.velocity, params.brightness, params.sampleRate);
    expect(voice.midi).toBe(60);
    expect(voice.startTime).toBe(0.1);
    expect(voice.naturalEndTime).toBeGreaterThan(0.1);
    expect(mock.oscillators).toHaveLength(spectrum.partials.length + 1);
    expect(voice.nodes.length).toBeGreaterThan(15);
    expect(mock.bufferSources).toHaveLength(1);
    expect(voice.released).toBe(false);
    expect(mock.oscillators.every((oscillator) => oscillator.frequency.value > 0)).toBe(true);
    expect(mock.oscillators.some((oscillator) => oscillator.detune.value !== 0)).toBe(true);

    voice.release(0.5);
    expect(voice.released).toBe(true);
    expect(mock.oscillators.every((oscillator) => oscillator.stopCalls.length >= 2)).toBe(true);

    for (const oscillator of mock.oscillators) oscillator.fireEnded();
    expect(ended).toBe(1);
    expect(voice.nodes.every((node) => (node as unknown as MockNode).disconnected)).toBe(true);
  });

  it('stopNow() on a not-yet-started voice frees nodes immediately', () => {
    const { mock, ctx } = makeMockContext();
    const noiseBuffer = createNoiseBuffer(ctx);
    let ended = 0;
    const voice = createPianoVoice(ctx, { ...params, when: 2, noiseBuffer }, () => {
      ended += 1;
    });

    voice.stopNow(0.5);
    expect(ended).toBe(1);
    expect(voice.isSilentAt(0.6)).toBe(true);
    expect(voice.nodes.every((node) => (node as unknown as MockNode).disconnected)).toBe(true);
    // Nothing should remain connected to the graph.
    expect(mock.nodes.every((node) => node.connections.length === 0)).toBe(true);
  });

  it('stopNow() on a sounding voice fades instead of clicking', () => {
    const { mock, ctx } = makeMockContext();
    const noiseBuffer = createNoiseBuffer(ctx);
    const voice = createPianoVoice(ctx, { ...params, noiseBuffer });

    voice.stopNow(0.3);
    expect(voice.isSilentAt(0.34)).toBe(false);
    expect(voice.isSilentAt(0.36)).toBe(true);
    expect(voice.isSilentAt(1)).toBe(true);
    expect(mock.oscillators.every((oscillator) => oscillator.stopCalls.length >= 2)).toBe(true);

    for (const oscillator of mock.oscillators) oscillator.fireEnded();
    expect(voice.nodes.every((node) => (node as unknown as MockNode).disconnected)).toBe(true);
  });

  it('exposes a sane voice budget', () => {
    expect(MAX_VOICES).toBeGreaterThanOrEqual(32);
    expect(MAX_VOICES).toBeLessThanOrEqual(128);
  });
});
