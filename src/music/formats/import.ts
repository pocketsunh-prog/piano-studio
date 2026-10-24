/**
 * Unified score-file import used by the app's "Open file" flow.
 *
 * Supported extensions:
 *  - `.mid` / `.midi` — Standard MIDI File
 *  - `.musicxml` / `.xml` — uncompressed MusicXML
 *  - `.mxl` — compressed MusicXML (ZIP; read with fflate)
 *
 * Imported files are untrusted: compressed archives are filtered to the score
 * entries only and capped by uncompressed size before decompression, and all
 * failures surface as a readable `Error`.
 */
import { unzipSync } from 'fflate';
import type { Score } from '../types';
import { parseMidi } from './midi';
import { parseMusicXml } from './musicxml';

const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    let out = '';
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
  }
}

function titleFromFileName(fileName: string, fallback: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function unzipCompressedMusicXml(data: ArrayBuffer): Record<string, Uint8Array> {
  const bytes = new Uint8Array(data);
  if (bytes.length === 0) throw new Error('Compressed MusicXML (.mxl) file is empty.');
  if (bytes.length > MAX_COMPRESSED_BYTES) {
    throw new Error('Compressed MusicXML (.mxl) file is too large to import.');
  }
  let totalUncompressed = 0;
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        const name = normalizeZipPath(file.name);
        const isCandidate = /container\.xml$/i.test(name) || /\.(musicxml|xml)$/i.test(name);
        if (!isCandidate) return false;
        if (file.originalSize > MAX_ENTRY_BYTES) {
          throw new Error('Compressed MusicXML contains an oversized entry; refusing to import it.');
        }
        totalUncompressed += file.originalSize;
        if (totalUncompressed > MAX_TOTAL_BYTES) {
          throw new Error('Compressed MusicXML expands to too much data; refusing to import it.');
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Compressed MusicXML')) throw error;
    throw new Error(
      `Compressed MusicXML is not a readable .mxl archive (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/** Picks the score document referenced by META-INF/container.xml (or the first XML entry). */
function findScoreEntry(files: Record<string, Uint8Array>): { name: string; bytes: Uint8Array } {
  const names = Object.keys(files);
  if (names.length === 0) {
    throw new Error('Compressed MusicXML (.mxl) file contains no XML entries.');
  }
  const containerName = names.find(
    (name) => normalizeZipPath(name).toLowerCase() === 'meta-inf/container.xml',
  );
  if (containerName) {
    const containerXml = decodeUtf8(files[containerName]);
    const match =
      /full-path\s*=\s*"([^"]+)"/i.exec(containerXml) ??
      /full-path\s*=\s*'([^']+)'/i.exec(containerXml);
    if (match && match[1]) {
      const wanted = normalizeZipPath(match[1]);
      const found =
        names.find((name) => normalizeZipPath(name) === wanted) ??
        names.find((name) => normalizeZipPath(name).toLowerCase() === wanted.toLowerCase());
      if (found) return { name: found, bytes: files[found] };
    }
  }
  const candidates = names.filter((name) => {
    const normalized = normalizeZipPath(name);
    return !/^meta-inf\//i.test(normalized) && /\.(musicxml|xml)$/i.test(normalized);
  });
  const chosen =
    candidates.find((name) => /\.musicxml$/i.test(name)) ?? candidates[0] ?? names[0];
  return { name: chosen, bytes: files[chosen] };
}

/**
 * Parses a score file based on its extension. Rejects unsupported extensions
 * and malformed content with clear errors.
 */
export async function parseScoreFile(fileName: string, data: ArrayBuffer): Promise<Score> {
  if (typeof fileName !== 'string' || fileName.trim() === '') {
    throw new Error('No file name was provided for import.');
  }
  if (!(data instanceof ArrayBuffer)) {
    throw new Error('Score import expects binary file data.');
  }
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';

  try {
    if (extension === 'mid' || extension === 'midi') {
      return parseMidi(data, titleFromFileName(fileName, 'Imported MIDI'));
    }
    if (extension === 'musicxml' || extension === 'xml') {
      if (data.byteLength === 0) throw new Error('File is empty.');
      return parseMusicXml(
        decodeUtf8(new Uint8Array(data)),
        titleFromFileName(fileName, 'Imported score'),
      );
    }
    if (extension === 'mxl') {
      const files = unzipCompressedMusicXml(data);
      const entry = findScoreEntry(files);
      return parseMusicXml(
        decodeUtf8(entry.bytes),
        titleFromFileName(fileName, 'Imported score'),
      );
    }
    throw new Error(
      `Unsupported file type "${extension ? `.${extension}` : fileName}". ` +
        'Import a .mid, .midi, .musicxml, .xml or .mxl file.',
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unsupported file type')) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not import "${fileName}": ${message}`);
  }
}
