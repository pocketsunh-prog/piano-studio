/**
 * Public entry point for the sheet-music format modules.
 *
 * The app may import the individual modules directly (as described in
 * CONTRACT.md §2) or use this barrel.
 */
export { parseMidi, writeMidi } from './midi';
export { parseMusicXml, writeMusicXml } from './musicxml';
export { DEFAULT_QUANTIZE_GRID, quantizeNotes, quantizeScore } from './quantize';
export { parseScoreFile } from './import';
export { buildExport, scoreFromJson, scoreToJson } from './export';
export type { ExportFormat } from './export';
