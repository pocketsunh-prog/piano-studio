/**
 * STUB — owned by the `audio-eng` teammate.
 * Replace this file with the real Web Audio piano engine (see CONTRACT.md).
 */
export interface PianoEngineOptions {
  volume?: number;
  reverbMix?: number;
  brightness?: number;
}

export type EngineState = 'suspended' | 'running' | 'closed';

export class PianoEngine {
  private ctx: AudioContext | null = null;

  constructor(public readonly options: PianoEngineOptions = {}) {}

  get state(): EngineState {
    if (!this.ctx) return 'suspended';
    if (this.ctx.state === 'closed') return 'closed';
    return this.ctx.state === 'running' ? 'running' : 'suspended';
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  async ensureStarted(): Promise<void> {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  scheduleNote(_midi: number, _velocity: number, _when: number, _duration: number): void {}
  noteOn(_midi: number, _velocity = 90): void {}
  noteOff(_midi: number): void {}
  sustain(_on: boolean): void {}
  setVolume(_v: number): void {}
  setReverbMix(_v: number): void {}
  metronomeClick(_when: number, _accent = false): void {}
  stopAll(): void {}
  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
