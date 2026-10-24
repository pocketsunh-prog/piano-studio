/**
 * STUB — owned by the `sheet-io` teammate.
 * Replace with a Standard MIDI File parser/writer (see CONTRACT.md).
 */
import type { Score } from '../types';

export function parseMidi(_data: ArrayBuffer, _fallbackTitle = 'Imported MIDI'): Score {
  throw new Error('MIDI import is not available yet.');
}

export function writeMidi(_score: Score): Uint8Array {
  throw new Error('MIDI export is not available yet.');
}
