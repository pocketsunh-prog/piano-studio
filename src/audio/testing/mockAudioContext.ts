/**
 * Minimal mock Web Audio implementation for jsdom tests.
 *
 * jsdom has no Web Audio API, so the engine tests install this through
 * `vi.stubGlobal('AudioContext', MockAudioContext)`. The mock records the graph
 * and every AudioParam automation call so tests can assert scheduling and
 * release behaviour without producing actual sound.
 */

export type MockParamEventType =
  | 'setValueAtTime'
  | 'linearRampToValueAtTime'
  | 'exponentialRampToValueAtTime'
  | 'setTargetAtTime'
  | 'cancelScheduledValues'
  | 'cancelAndHoldAtTime';

export interface MockParamEvent {
  readonly type: MockParamEventType;
  readonly value?: number;
  readonly time: number;
  readonly timeConstant?: number;
}

export class MockAudioParam {
  value: number;
  readonly events: MockParamEvent[] = [];

  constructor(value = 0) {
    this.value = value;
  }

  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'setValueAtTime', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'linearRampToValueAtTime', value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'exponentialRampToValueAtTime', value, time });
    return this;
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): this {
    this.events.push({ type: 'setTargetAtTime', value: target, time: startTime, timeConstant });
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.events.push({ type: 'cancelScheduledValues', time });
    return this;
  }

  cancelAndHoldAtTime(time: number): this {
    this.events.push({ type: 'cancelAndHoldAtTime', time });
    return this;
  }

  eventsOf(type: MockParamEventType): MockParamEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  hasEvent(type: MockParamEventType): boolean {
    return this.events.some((event) => event.type === type);
  }
}

export class MockNode {
  readonly connections: MockNode[] = [];
  disconnected = false;

  connect(destination: MockNode): void {
    this.connections.push(destination);
  }

  disconnect(): void {
    this.connections.length = 0;
    this.disconnected = true;
  }
}

export class MockGainNode extends MockNode {
  readonly gain = new MockAudioParam(1);
}

export class MockOscillatorNode extends MockNode {
  type: OscillatorType = 'sine';
  readonly frequency = new MockAudioParam(440);
  readonly detune = new MockAudioParam(0);
  readonly startCalls: number[] = [];
  readonly stopCalls: number[] = [];
  onended: (() => void) | null = null;

  start(when = 0): void {
    this.startCalls.push(when);
  }

  stop(when = 0): void {
    this.stopCalls.push(when);
  }

  fireEnded(): void {
    this.onended?.();
  }
}

export class MockBufferSourceNode extends MockNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  readonly playbackRate = new MockAudioParam(1);
  readonly startCalls: number[] = [];
  readonly stopCalls: number[] = [];
  onended: (() => void) | null = null;

  start(when = 0, offset = 0): void {
    void offset;
    this.startCalls.push(when);
  }

  stop(when = 0): void {
    this.stopCalls.push(when);
  }

  fireEnded(): void {
    this.onended?.();
  }
}

export class MockStereoPannerNode extends MockNode {
  readonly pan = new MockAudioParam(0);
}

export class MockBiquadFilterNode extends MockNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new MockAudioParam(350);
  readonly Q = new MockAudioParam(1);
  readonly gain = new MockAudioParam(0);
}

export class MockConvolverNode extends MockNode {
  buffer: AudioBuffer | null = null;
  normalize = true;
}

export class MockDynamicsCompressorNode extends MockNode {
  readonly threshold = new MockAudioParam(-24);
  readonly knee = new MockAudioParam(30);
  readonly ratio = new MockAudioParam(12);
  readonly attack = new MockAudioParam(0.003);
  readonly release = new MockAudioParam(0.25);
}

export class MockWaveShaperNode extends MockNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
}

export class MockAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new Error(`MockAudioBuffer: channel ${channel} does not exist.`);
    return data;
  }
}

export class MockAudioContext {
  static instances: MockAudioContext[] = [];

  state: AudioContextState = 'suspended';
  currentTime = 0;
  readonly sampleRate: number;
  readonly destination: MockNode;
  readonly nodes: MockNode[] = [];
  readonly gains: MockGainNode[] = [];
  readonly oscillators: MockOscillatorNode[] = [];
  readonly bufferSources: MockBufferSourceNode[] = [];
  resumeCalls = 0;
  closeCalls = 0;

  constructor(options: { sampleRate?: number } = {}) {
    this.sampleRate = options.sampleRate ?? 44100;
    this.destination = new MockNode();
    MockAudioContext.instances.push(this);
  }

  static last(): MockAudioContext | undefined {
    return MockAudioContext.instances[MockAudioContext.instances.length - 1];
  }

  static reset(): void {
    MockAudioContext.instances.length = 0;
  }

  private track<T extends MockNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  createGain(): GainNode {
    const node = this.track(new MockGainNode());
    this.gains.push(node);
    return node as unknown as GainNode;
  }

  createOscillator(): OscillatorNode {
    const node = this.track(new MockOscillatorNode());
    this.oscillators.push(node);
    return node as unknown as OscillatorNode;
  }

  createBufferSource(): AudioBufferSourceNode {
    const node = this.track(new MockBufferSourceNode());
    this.bufferSources.push(node);
    return node as unknown as AudioBufferSourceNode;
  }

  createStereoPanner(): StereoPannerNode {
    return this.track(new MockStereoPannerNode()) as unknown as StereoPannerNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    return this.track(new MockBiquadFilterNode()) as unknown as BiquadFilterNode;
  }

  createConvolver(): ConvolverNode {
    return this.track(new MockConvolverNode()) as unknown as ConvolverNode;
  }

  createDynamicsCompressor(): DynamicsCompressorNode {
    return this.track(new MockDynamicsCompressorNode()) as unknown as DynamicsCompressorNode;
  }

  createWaveShaper(): WaveShaperNode {
    return this.track(new MockWaveShaperNode()) as unknown as WaveShaperNode;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    return new MockAudioBuffer(numberOfChannels, length, sampleRate) as unknown as AudioBuffer;
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** Finds an untouched gain node by its initial value (e.g. the master bus). */
export function findStaticGain(ctx: MockAudioContext, value: number, tolerance = 1e-9): MockGainNode | undefined {
  return ctx.gains.find(
    (gain) => Math.abs(gain.gain.value - value) <= tolerance && gain.gain.events.length === 0,
  );
}
