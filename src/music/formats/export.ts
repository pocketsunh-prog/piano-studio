/**
 * STUB — owned by the `sheet-io` teammate.
 */
import type { Score } from '../types';

export type ExportFormat = 'musicxml' | 'midi' | 'json';

export function buildExport(
  _score: Score,
  _format: ExportFormat,
): { fileName: string; mime: string; data: string | Uint8Array } {
  throw new Error('Export is not available yet.');
}

export function scoreToJson(_score: Score): string {
  return '{}';
}

export function scoreFromJson(_text: string): Score {
  throw new Error('Score JSON import is not available yet.');
}
