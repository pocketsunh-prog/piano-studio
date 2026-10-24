/**
 * STUB — owned by the `sheet-io` teammate.
 * Replace with a MusicXML parser/writer (see CONTRACT.md).
 */
import type { Score } from '../types';

export function parseMusicXml(_xml: string, _fallbackTitle = 'Imported score'): Score {
  throw new Error('MusicXML import is not available yet.');
}

export function writeMusicXml(_score: Score): string {
  throw new Error('MusicXML export is not available yet.');
}
