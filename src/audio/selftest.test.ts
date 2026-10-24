import { describe, expect, it } from 'vitest';
import { getOfflineAudioContextConstructor, runAudioSelfTest } from './selftest';

describe('runAudioSelfTest', () => {
  it('rejects with a clear error when OfflineAudioContext is unavailable', async () => {
    // jsdom has no Web Audio implementation; the real browser path is checked
    // separately by driving the page on a dev server.
    if (getOfflineAudioContextConstructor()) return;
    await expect(runAudioSelfTest()).rejects.toThrow(/OfflineAudioContext/);
  });

  it('exports an importable, side-effect-free self-test', () => {
    expect(typeof runAudioSelfTest).toBe('function');
  });
});
