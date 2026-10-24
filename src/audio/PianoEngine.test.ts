import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PianoEngine, type PianoEngineOptions } from './PianoEngine';
import { MAX_VOICES, REVERB_WET_SCALE, computePianoSpectrum } from './synth';
import {
  MockAudioContext,
  MockNode,
  findStaticGain,
} from './testing/mockAudioContext';

let engine: PianoEngine | undefined;

function makeEngine(options?: PianoEngineOptions): PianoEngine {
  engine = new PianoEngine(options);
  return engine;
}

function mockContextOf(target: PianoEngine): MockAudioContext {
  const ctx = target.context;
  if (!ctx) throw new Error('expected the engine to have an AudioContext');
  return ctx as unknown as MockAudioContext;
}

beforeEach(() => {
  MockAudioContext.reset();
  vi.stubGlobal('AudioContext', MockAudioContext);
});

afterEach(() => {
  engine?.dispose();
  engine = undefined;
  vi.unstubAllGlobals();
  MockAudioContext.reset();
});

describe('PianoEngine — lifecycle', () => {
  it('is lazy and reports suspended before ensureStarted()', () => {
    const piano = makeEngine();
    expect(piano.state).toBe('suspended');
    expect(piano.context).toBeNull();
    expect(piano.now()).toBe(0);
    expect(MockAudioContext.instances).toHaveLength(0);
  });

  it('ensureStarted creates and resumes one context, repeatedly safe', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);

    expect(piano.state).toBe('running');
    expect(piano.now()).toBe(0);
    expect(ctx.resumeCalls).toBe(1);
    expect(MockAudioContext.instances).toHaveLength(1);

    ctx.currentTime = 1.25;
    expect(piano.now()).toBe(1.25);

    await piano.ensureStarted();
    await Promise.all([piano.ensureStarted(), piano.ensureStarted()]);
    expect(MockAudioContext.instances).toHaveLength(1);
    expect(ctx.resumeCalls).toBe(1);
  });

  it('applies constructor options to the master bus', async () => {
    const piano = makeEngine({ volume: 0.5, reverbMix: 0.4, brightness: 0.9 });
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);

    expect(findStaticGain(ctx, 0.5)).toBeDefined(); // master gain
    expect(findStaticGain(ctx, 0.4 * REVERB_WET_SCALE)).toBeDefined(); // reverb return
  });

  it('applies setVolume() called before the context exists', async () => {
    const piano = makeEngine();
    piano.setVolume(0.3);
    await piano.ensureStarted();
    expect(findStaticGain(mockContextOf(piano), 0.3)).toBeDefined();
  });

  it('starts a context lazily from noteOn()', () => {
    const piano = makeEngine();
    piano.noteOn(64, 100);
    expect(MockAudioContext.instances).toHaveLength(1);
    expect(piano.activeVoiceCount).toBe(1);
    expect(mockContextOf(piano).oscillators.length).toBeGreaterThan(0);
  });

  it('dispose closes the context, is idempotent and throws on later use', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);

    piano.dispose();
    expect(piano.state).toBe('closed');
    expect(piano.context).toBeNull();
    expect(ctx.closeCalls).toBe(1);

    expect(() => piano.noteOn(60)).toThrow(/disposed/i);
    expect(() => piano.noteOff(60)).toThrow(/disposed/i);
    expect(() => piano.sustain(true)).toThrow(/disposed/i);
    expect(() => piano.scheduleNote(60, 90, 1, 1)).toThrow(/disposed/i);
    expect(() => piano.metronomeClick(1)).toThrow(/disposed/i);
    await expect(piano.ensureStarted()).rejects.toThrow(/disposed/i);

    piano.dispose();
    expect(ctx.closeCalls).toBe(1);
    expect(() => piano.stopAll()).not.toThrow();
  });

  it('throws a clear error when the Web Audio API is missing', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const piano = makeEngine();
    await expect(piano.ensureStarted()).rejects.toThrow(/Web Audio/i);
    expect(() => piano.noteOn(60)).toThrow(/Web Audio/i);
    expect(() => piano.scheduleNote(60, 90, 1, 1)).toThrow(/Web Audio/i);
  });
});

describe('PianoEngine — scheduling', () => {
  it('scheduleNote() builds a full piano voice at the requested time', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);
    ctx.currentTime = 0.25;

    const oscillatorsBefore = ctx.oscillators.length;
    const gainsBefore = ctx.gains.length;
    const sourcesBefore = ctx.bufferSources.length;

    piano.scheduleNote(60, 100, 0.75, 1.2);
    const spectrum = computePianoSpectrum(60, 100, 0.5, 44100);
    const oscillators = ctx.oscillators.slice(oscillatorsBefore);

    expect(oscillators).toHaveLength(spectrum.partials.length + 1); // + detuned unison
    for (const oscillator of oscillators) {
      expect(oscillator.startCalls).toHaveLength(1);
      expect(oscillator.startCalls[0]).toBeCloseTo(0.75, 6);
      // A natural stop is scheduled, then the note release overrides it.
      expect(oscillator.stopCalls.length).toBeGreaterThanOrEqual(2);
      expect(oscillator.stopCalls[oscillator.stopCalls.length - 1]).toBeLessThan(4);
    }
    expect(ctx.gains.length).toBeGreaterThan(gainsBefore);
    expect(ctx.bufferSources.length).toBe(sourcesBefore + 1); // hammer noise
    expect(piano.activeVoiceCount).toBe(1);
  });

  it('scheduleNote() clamps past times and drops notes that already finished', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);
    ctx.currentTime = 5;

    const voicesBefore = piano.activeVoiceCount;
    piano.scheduleNote(60, 90, 1, 0.5); // finished long ago
    expect(piano.activeVoiceCount).toBe(voicesBefore);

    piano.scheduleNote(60, 90, 4.95, 1); // starts now
    expect(piano.activeVoiceCount).toBe(voicesBefore + 1);
    const started = ctx.oscillators.filter((osc) => osc.startCalls[0] === 5);
    expect(started.length).toBeGreaterThan(0);
  });

  it('noteOff() damps a live voice and it is freed when its oscillators end', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);

    piano.noteOn(60, 110);
    const oscillators = ctx.oscillators.slice();
    expect(oscillators.length).toBeGreaterThan(0);
    expect(piano.activeVoiceCount).toBe(1);
    for (const oscillator of oscillators) expect(oscillator.stopCalls).toHaveLength(1);

    ctx.currentTime = 0.1;
    piano.noteOff(60);
    for (const oscillator of oscillators) {
      expect(oscillator.stopCalls).toHaveLength(2);
      expect(oscillator.stopCalls[1]).toBeGreaterThan(0.1);
      expect(oscillator.stopCalls[1]).toBeLessThan(2);
    }

    // Simulate the browser finishing the nodes.
    for (const oscillator of oscillators) oscillator.fireEnded();
    expect(piano.activeVoiceCount).toBe(0);
  });

  it('sustain defers damping until the pedal comes up', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);

    piano.noteOn(60, 100);
    const oscillators = ctx.oscillators.slice();
    expect(oscillators.length).toBeGreaterThan(0);
    const stopCallsAfterStart = oscillators.map((osc) => osc.stopCalls.length);

    piano.sustain(true);
    piano.noteOff(60);
    oscillators.forEach((osc, index) => {
      expect(osc.stopCalls.length).toBe(stopCallsAfterStart[index]);
    });

    piano.sustain(false);
    for (const oscillator of oscillators) {
      expect(oscillator.stopCalls.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('retriggering a held note replaces the previous voice', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);

    piano.noteOn(60, 100);
    const first = ctx.oscillators.slice();
    ctx.currentTime = 0.2;
    piano.noteOn(60, 100);
    const second = ctx.oscillators.slice(first.length);

    expect(second.length).toBeGreaterThan(0);
    // The old voice was hard-stopped when the string was struck again.
    for (const oscillator of first) expect(oscillator.stopCalls.length).toBeGreaterThanOrEqual(2);
    expect(piano.activeVoiceCount).toBeLessThanOrEqual(2);
  });

  it('caps concurrent voices at MAX_VOICES', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    for (let i = 0; i < MAX_VOICES + 24; i += 1) {
      piano.noteOn(21 + (i % 88), 80);
    }
    expect(piano.activeVoiceCount).toBe(MAX_VOICES);
  });

  it('stopAll cancels scheduled and live voices', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);
    ctx.currentTime = 0.3;

    piano.noteOn(60, 100);
    piano.scheduleNote(72, 90, ctx.currentTime + 5, 1);
    expect(piano.activeVoiceCount).toBe(2);
    const oscillators = ctx.oscillators.slice();

    piano.stopAll();
    expect(piano.activeVoiceCount).toBe(0);
    for (const oscillator of oscillators) {
      expect(oscillator.stopCalls.length).toBeGreaterThanOrEqual(2);
    }
    // The future voice is freed immediately, not left dangling.
    const nodes = ctx.nodes as MockNode[];
    expect(nodes.some((node) => node.disconnected)).toBe(true);
  });

  it('tolerates malformed scheduling input', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    expect(() => piano.scheduleNote(Number.NaN, Number.NaN, Number.NaN, Number.NaN)).not.toThrow();
    expect(() => piano.scheduleNote(60, 90, 5, Number.NaN)).not.toThrow();
    expect(() => piano.noteOn(Number.NaN, Number.NaN)).not.toThrow();
    expect(() => piano.noteOff(999)).not.toThrow();
    expect(() => piano.sustain(true)).not.toThrow();
    expect(() => piano.sustain(false)).not.toThrow();
  });
});

describe('PianoEngine — controls', () => {
  it('setVolume and setReverbMix clamp and automate the master bus', async () => {
    const piano = makeEngine({ volume: 0.8, reverbMix: 0.22 });
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);

    const master = findStaticGain(ctx, 0.8);
    const wet = findStaticGain(ctx, 0.22 * REVERB_WET_SCALE);
    if (!master || !wet) throw new Error('master bus gains not found');

    piano.setVolume(0.35);
    expect(master.gain.eventsOf('setTargetAtTime').some((event) => event.value === 0.35)).toBe(true);

    piano.setVolume(4);
    expect(master.gain.eventsOf('setTargetAtTime').some((event) => event.value === 1)).toBe(true);
    piano.setVolume(-2);
    expect(master.gain.eventsOf('setTargetAtTime').some((event) => event.value === 0)).toBe(true);

    piano.setReverbMix(0.5);
    expect(wet.gain.eventsOf('setTargetAtTime').some((event) => event.value === 0.5 * REVERB_WET_SCALE)).toBe(
      true,
    );
  });

  it('metronomeClick schedules a dry click at the requested time', async () => {
    const piano = makeEngine();
    await piano.ensureStarted();
    const ctx = mockContextOf(piano);
    ctx.currentTime = 0.2;

    piano.metronomeClick(0.6, true);
    expect(ctx.oscillators).toHaveLength(1);
    const click = ctx.oscillators[0];
    expect(click.startCalls[0]).toBeCloseTo(0.6, 6);
    expect(click.stopCalls).toHaveLength(1);
    expect(click.frequency.value).toBeGreaterThan(1000);
    expect(ctx.bufferSources).toHaveLength(1);

    expect(() => piano.metronomeClick(Number.NaN)).not.toThrow();
  });
});
