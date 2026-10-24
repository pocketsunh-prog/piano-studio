/**
 * Piano Studio — Web Audio piano engine.
 *
 * A polyphonic, velocity-sensitive piano synthesizer built on additive
 * inharmonic partials. See `synth.ts` for the voice and master-bus design.
 *
 * Public API is fixed by CONTRACT.md §1. All scheduling methods take absolute
 * `AudioContext` times (seconds), so a transport can hand the engine notes
 * ahead of time (the app schedules with ~1 s lookahead).
 */
import { clampMidi } from '../music/timing';
import {
  MAX_VOICES,
  createMasterChain,
  createNoiseBuffer,
  createPianoVoice,
  type MasterChain,
  type PianoVoice,
} from './synth';

export interface PianoEngineOptions {
  /** Master volume 0..1 (default 0.8). */
  volume?: number;
  /** Reverb mix 0..1 (default 0.22). */
  reverbMix?: number;
  /** Timbre 0..1, 0 = mellow, 1 = bright (default 0.5). */
  brightness?: number;
}

export type EngineState = 'suspended' | 'running' | 'closed';

const DEFAULT_VOLUME = 0.8;
const DEFAULT_REVERB_MIX = 0.22;
const DEFAULT_BRIGHTNESS = 0.5;
const DEFAULT_VELOCITY = 90;
const MIN_NOTE_SECONDS = 0.02;

interface VoiceRecord {
  readonly midi: number;
  readonly kind: 'live' | 'scheduled';
  readonly handle: PianoVoice;
}

interface AudioContextGlobal {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function resolveAudioContextConstructor(): typeof AudioContext {
  const scope = globalThis as unknown as AudioContextGlobal;
  const Constructor =
    typeof scope.AudioContext === 'function'
      ? scope.AudioContext
      : typeof scope.webkitAudioContext === 'function'
        ? scope.webkitAudioContext
        : null;
  if (!Constructor) {
    throw new Error('PianoEngine requires the Web Audio API, which is not available in this environment.');
  }
  return Constructor;
}

/**
 * Polyphonic Web Audio piano.
 *
 * The class is lazy: no AudioContext is created until `ensureStarted()` (or the
 * first note) is called. `ensureStarted()` is safe to call many times, and every
 * scheduling method tolerates times slightly in the past.
 */
export class PianoEngine {
  /** Effective options, with defaults applied. */
  public readonly options: PianoEngineOptions;

  private ctx: AudioContext | null = null;
  private chain: MasterChain | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private disposed = false;
  private resumePromise: Promise<void> | null = null;
  private volume: number;
  private reverbMix: number;
  private readonly brightness: number;
  private sustainOn = false;
  private readonly voices = new Set<VoiceRecord>();
  private readonly held = new Map<number, Set<VoiceRecord>>();
  private readonly sustained = new Set<VoiceRecord>();
  private levelBuffer: Float32Array<ArrayBuffer> | null = null;

  constructor(options: PianoEngineOptions = {}) {
    this.volume = clamp01(finiteOr(options.volume, DEFAULT_VOLUME));
    this.reverbMix = clamp01(finiteOr(options.reverbMix, DEFAULT_REVERB_MIX));
    this.brightness = clamp01(finiteOr(options.brightness, DEFAULT_BRIGHTNESS));
    this.options = {
      volume: this.volume,
      reverbMix: this.reverbMix,
      brightness: this.brightness,
    };
  }

  get state(): EngineState {
    if (this.disposed) return 'closed';
    const ctx = this.ctx;
    if (!ctx) return 'suspended';
    if (ctx.state === 'closed') return 'closed';
    return ctx.state === 'running' ? 'running' : 'suspended';
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Current AudioContext time (0 before the context exists). */
  now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Number of voices currently tracked (diagnostic; steals/prunes lazily). */
  get activeVoiceCount(): number {
    const ctx = this.liveContext();
    if (ctx) this.pruneSilent(ctx.currentTime);
    return this.voices.size;
  }

  /**
   * Current master-output level (0..1, UI-friendly scaling) for a sound meter.
   * Returns 0 when the context is not running or analyser data is unavailable.
   */
  getOutputLevel(): number {
    try {
      const ctx = this.ctx;
      const analyser = this.chain?.analyser;
      if (!ctx || ctx.state !== 'running' || !analyser) return 0;
      if (!this.levelBuffer || this.levelBuffer.length !== analyser.fftSize) {
        this.levelBuffer = new Float32Array(analyser.fftSize);
      }
      analyser.getFloatTimeDomainData(this.levelBuffer);
      let sumSquares = 0;
      for (let i = 0; i < this.levelBuffer.length; i += 1) {
        const sample = this.levelBuffer[i];
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / this.levelBuffer.length);
      return Math.min(1, rms * 5.5);
    } catch {
      return 0;
    }
  }

  /**
   * Creates and resumes the AudioContext. Call from a user gesture the first
   * time. Repeated calls are safe; the promise resolves once the context exists
   * (a blocked resume leaves the engine usable in suspended state).
   */
  async ensureStarted(): Promise<void> {
    const ctx = this.requireContext();
    if (ctx.state !== 'running') await this.resumeContext(ctx);
  }

  /**
   * Plays a note at an absolute AudioContext time. A negative or non-finite
   * duration is replaced by a short default; notes wholly in the past are
   * dropped.
   */
  scheduleNote(midi: number, velocity: number, when: number, duration: number): void {
    if (this.disposed) throw new Error('PianoEngine has been disposed.');
    if (!Number.isFinite(when)) return;
    const ctx = this.activeContext();
    const now = ctx.currentTime;
    const start = Math.max(when, now);
    const length =
      Number.isFinite(duration) && duration > 0 ? Math.max(MIN_NOTE_SECONDS, duration) : MIN_NOTE_SECONDS;
    // A note that is already fully in the past can be dropped silently.
    if (when + length <= now + 0.01) return;
    this.startVoice(ctx, 'scheduled', midi, velocity, start, length);
  }

  /** Starts a note immediately (live keyboard playing). */
  noteOn(midi: number, velocity = DEFAULT_VELOCITY): void {
    if (this.disposed) throw new Error('PianoEngine has been disposed.');
    const ctx = this.activeContext();
    const now = ctx.currentTime;
    const noteMidi = clampMidi(finiteOr(midi, 60));

    // Retrigger: the same string is struck again, so silence older instances.
    const previous = this.held.get(noteMidi);
    if (previous) {
      this.held.delete(noteMidi);
      for (const record of previous) record.handle.stopNow(now + 0.005);
    }
    for (const record of [...this.sustained]) {
      if (record.midi === noteMidi) {
        this.sustained.delete(record);
        record.handle.stopNow(now + 0.01);
      }
    }

    this.startVoice(ctx, 'live', noteMidi, velocity, now + 0.002, null);
  }

  /** Releases a held note (damper pedal honoured). */
  noteOff(midi: number): void {
    if (this.disposed) throw new Error('PianoEngine has been disposed.');
    const ctx = this.liveContext();
    if (!ctx) return;
    const noteMidi = clampMidi(finiteOr(midi, 60));
    const records = this.held.get(noteMidi);
    if (!records) return;
    this.held.delete(noteMidi);
    const now = ctx.currentTime;
    for (const record of records) {
      if (this.sustainOn) this.sustained.add(record);
      else record.handle.release(now + 0.003);
    }
  }

  /** Damper pedal. Releasing the pedal dampens all sustained voices. */
  sustain(on: boolean): void {
    if (this.disposed) throw new Error('PianoEngine has been disposed.');
    const next = Boolean(on);
    if (next === this.sustainOn) return;
    this.sustainOn = next;
    if (next) return;
    const ctx = this.liveContext();
    const now = ctx ? ctx.currentTime : 0;
    for (const record of this.sustained) {
      if (ctx) record.handle.release(now + 0.01);
    }
    this.sustained.clear();
  }

  /** Sets the master volume (clamped to 0..1). */
  setVolume(v: number): void {
    const value = clamp01(finiteOr(v, this.volume));
    this.volume = value;
    if (this.disposed) return;
    const ctx = this.liveContext();
    if (ctx && this.chain) this.chain.setVolume(value);
  }

  /** Sets the reverb mix (clamped to 0..1). */
  setReverbMix(v: number): void {
    const value = clamp01(finiteOr(v, this.reverbMix));
    this.reverbMix = value;
    if (this.disposed) return;
    const ctx = this.liveContext();
    if (ctx && this.chain) this.chain.setReverbMix(value);
  }

  /** Plays a short metronome click at an absolute time. */
  metronomeClick(when: number, accent = false): void {
    if (this.disposed) throw new Error('PianoEngine has been disposed.');
    const ctx = this.activeContext();
    const chain = this.chain;
    if (!chain) return;
    const at = Math.max(Number.isFinite(when) ? when : ctx.currentTime, ctx.currentTime);
    const isAccent = Boolean(accent);
    const peak = isAccent ? 0.3 : 0.18;

    // Pitched body of the click.
    const oscillator = ctx.createOscillator();
    oscillator.type = 'triangle';
    oscillator.frequency.value = isAccent ? 1568 : 1046.5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.0015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
    gain.gain.linearRampToValueAtTime(0, at + 0.06);
    oscillator.connect(gain);
    gain.connect(chain.dryInput);
    oscillator.start(at);
    oscillator.stop(at + 0.08);

    // Tiny noise transient for definition.
    const noise = ctx.createBufferSource();
    if (this.noiseBuffer) noise.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 3200;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0, at);
    noiseGain.gain.linearRampToValueAtTime(peak * 0.5, at + 0.001);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.02);
    noiseGain.gain.linearRampToValueAtTime(0, at + 0.03);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(chain.dryInput);
    noise.start(at);
    noise.stop(at + 0.04);

    oscillator.onended = (): void => {
      try {
        oscillator.disconnect();
        gain.disconnect();
      } catch {
        // Already disconnected.
      }
    };
    noise.onended = (): void => {
      try {
        noise.disconnect();
        filter.disconnect();
        noiseGain.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }

  /** Cancels scheduled voices and silences everything currently sounding. */
  stopAll(): void {
    if (this.disposed) return;
    const ctx = this.liveContext();
    const now = ctx ? ctx.currentTime : 0;
    for (const record of this.voices) record.handle.stopNow(now);
    this.voices.clear();
    this.held.clear();
    this.sustained.clear();
  }

  /** Releases all resources. Safe to call multiple times; later use throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const ctx = this.ctx;
    const now = ctx && ctx.state !== 'closed' ? ctx.currentTime : 0;
    for (const record of this.voices) {
      try {
        record.handle.stopNow(now);
      } catch {
        // Best effort teardown.
      }
    }
    this.voices.clear();
    this.held.clear();
    this.sustained.clear();
    this.teardownGraph();
    this.ctx = null;
    this.resumePromise = null;
    if (ctx && ctx.state !== 'closed') {
      try {
        void ctx.close().catch(() => undefined);
      } catch {
        // Some implementations throw synchronously when already closing.
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private liveContext(): AudioContext | null {
    if (this.disposed) throw new Error('PianoEngine has been disposed.');
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return null;
    return ctx;
  }

  private requireContext(): AudioContext {
    if (this.disposed) throw new Error('PianoEngine has been disposed.');
    const existing = this.ctx;
    if (existing && existing.state === 'closed') {
      this.teardownGraph();
      this.ctx = null;
    }
    if (this.ctx) return this.ctx;

    const Constructor = resolveAudioContextConstructor();
    let created: AudioContext;
    try {
      created = new Constructor();
    } catch (error) {
      throw new Error(`PianoEngine could not create an AudioContext: ${describeError(error)}`);
    }
    this.ctx = created;
    this.chain = createMasterChain(created, { volume: this.volume, reverbMix: this.reverbMix });
    this.noiseBuffer = createNoiseBuffer(created);
    return created;
  }

  private activeContext(): AudioContext {
    const ctx = this.requireContext();
    if (ctx.state === 'suspended') this.nudgeResume(ctx);
    return ctx;
  }

  private nudgeResume(ctx: AudioContext): void {
    if (this.resumePromise) return;
    void this.resumeContext(ctx);
  }

  private resumeContext(ctx: AudioContext): Promise<void> {
    if (this.resumePromise) return this.resumePromise;
    const attempt = ctx
      .resume()
      .then(() => undefined)
      .catch(() => undefined);
    this.resumePromise = attempt;
    void attempt.finally(() => {
      if (this.resumePromise === attempt) this.resumePromise = null;
    });
    return attempt;
  }

  private teardownGraph(): void {
    this.chain?.dispose();
    this.chain = null;
    this.noiseBuffer = null;
  }

  private startVoice(
    ctx: AudioContext,
    kind: 'live' | 'scheduled',
    midi: number,
    velocity: number,
    when: number,
    holdSeconds: number | null,
  ): VoiceRecord | null {
    this.pruneSilent(ctx.currentTime);
    while (this.voices.size >= MAX_VOICES) {
      if (!this.stealVoice(ctx.currentTime)) break;
    }
    if (!this.noiseBuffer) return null;
    const chain = this.chain;
    if (!chain) return null;

    let record: VoiceRecord | null = null;
    const handle = createPianoVoice(
      ctx,
      {
        midi,
        velocity,
        brightness: this.brightness,
        when,
        sampleRate: ctx.sampleRate,
        noiseBuffer: this.noiseBuffer,
      },
      () => {
        if (record) this.cleanupRecord(record);
      },
    );
    // Route the voice into the master bus. Without this the synth runs but is
    // inaudible (no path to the AudioContext destination).
    handle.output.connect(chain.input);
    record = {
      midi: handle.midi,
      kind,
      handle,
    };
    this.voices.add(record);
    if (kind === 'live') {
      let set = this.held.get(record.midi);
      if (!set) {
        set = new Set<VoiceRecord>();
        this.held.set(record.midi, set);
      }
      set.add(record);
    }
    if (holdSeconds !== null) handle.release(when + Math.max(MIN_NOTE_SECONDS, holdSeconds));
    return record;
  }

  private stealVoice(now: number): boolean {
    const victim = this.voices.values().next().value as VoiceRecord | undefined;
    if (!victim) return false;
    this.cleanupRecord(victim);
    victim.handle.stopNow(now + 0.005);
    return true;
  }

  private pruneSilent(now: number): void {
    if (this.voices.size === 0) return;
    for (const record of [...this.voices]) {
      if (!record.handle.isSilentAt(now)) continue;
      this.cleanupRecord(record);
      record.handle.dispose();
    }
  }

  private cleanupRecord(record: VoiceRecord): void {
    this.voices.delete(record);
    const set = this.held.get(record.midi);
    if (set) {
      set.delete(record);
      if (set.size === 0) this.held.delete(record.midi);
    }
    this.sustained.delete(record);
  }
}
