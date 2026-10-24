/**
 * Online sheet search via the Wikimedia Commons MediaWiki API.
 *
 * Commons hosts public-domain / CC-licensed MIDI performances and PDF sheet
 * scans. MIDI results can be imported directly into the app; PDF/image results
 * open in a new tab. The API supports anonymous CORS (`origin=*`), so no proxy
 * or key is needed.
 */
import type { Score } from '../types';
import { parseScoreFile } from '../formats/import';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

export type OnlineSheetKind = 'midi' | 'pdf' | 'image';

export interface OnlineSheetResult {
  id: string;
  /** Display title without the File: prefix and extension. */
  title: string;
  /** Original Commons page title. */
  pageTitle: string;
  fileUrl: string;
  descriptionUrl: string;
  mime: string;
  sizeBytes: number;
  kind: OnlineSheetKind;
  artist?: string;
  license?: string;
  thumbnailUrl?: string;
}

export interface OnlineSheetSearchResult {
  midi: OnlineSheetResult[];
  sheets: OnlineSheetResult[];
}

interface CommonsImageInfo {
  url?: string;
  descriptionurl?: string;
  mime?: string;
  size?: number;
  thumburl?: string;
  extmetadata?: Record<string, { value?: unknown }>;
}

interface CommonsPage {
  pageid?: number;
  title?: string;
  index?: number;
  imageinfo?: CommonsImageInfo[];
}

interface CommonsResponse {
  query?: { pages?: Record<string, CommonsPage> };
  error?: { info?: string };
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function metaValue(info: CommonsImageInfo, key: string): string | undefined {
  const raw = info.extmetadata?.[key]?.value;
  if (typeof raw !== 'string') return undefined;
  const cleaned = stripHtml(raw);
  return cleaned || undefined;
}

function cleanTitle(pageTitle: string): string {
  let title = pageTitle.replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '');
  title = title.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  title = title.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
  title = title.replace(/\s+(sheet[\s-]*music|score)\s*$/i, '').trim();
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function cleanArtist(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let artist = stripHtml(raw).replace(/\s+/g, ' ').trim();
  // Drop "(Life time: June 27, 1859 – June 5, 1916)" and similar wiki annotations.
  artist = artist
    .replace(/\s*\([^)]*(?:life\s*time|born|died|fl\.|\b\d{3,4}\b)[^)]*\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!artist) return undefined;
  return artist.slice(0, 80);
}

/** Pure converter used by the search and the unit tests. */
export function parseCommonsPages(
  payload: CommonsResponse,
  expectedKind: Exclude<OnlineSheetKind, 'image'>,
): OnlineSheetResult[] {
  const pages = payload.query?.pages;
  if (!pages) return [];
  return Object.entries(pages)
    .map(([id, page]) => ({ id, page }))
    .sort((a, b) => (a.page.index ?? 999) - (b.page.index ?? 999))
    .flatMap(({ id, page }) => {
      const info = page.imageinfo?.[0];
      const pageTitle = page.title ?? '';
      if (!info?.url || !pageTitle) return [];
      const mime = info.mime ?? '';
      const kind: OnlineSheetKind = mime.includes('midi')
        ? 'midi'
        : mime === 'application/pdf'
          ? 'pdf'
          : 'image';
      if (expectedKind === 'midi' && kind !== 'midi') return [];
      if (expectedKind === 'pdf' && kind !== 'pdf') return [];
      return [
        {
          id: `commons-${id}`,
          title: cleanTitle(pageTitle),
          pageTitle,
          fileUrl: info.url.split('?')[0],
          descriptionUrl:
            info.descriptionurl ??
            `https://commons.wikimedia.org/wiki/${encodeURIComponent(pageTitle)}`,
          mime,
          sizeBytes: info.size ?? 0,
          kind,
          artist: cleanArtist(metaValue(info, 'Artist')),
          license: metaValue(info, 'LicenseShortName'),
          thumbnailUrl: info.thumburl,
        } satisfies OnlineSheetResult,
      ];
    });
}

async function fetchCommonsSearch(
  search: string,
  expectedKind: 'midi' | 'pdf',
  limit: number,
  signal?: AbortSignal,
): Promise<OnlineSheetResult[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrsearch: search,
    gsrnamespace: '6',
    gsrlimit: String(Math.min(20, Math.max(1, limit))),
    prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata',
    iiurlwidth: '240',
  });
  const response = await fetch(`${COMMONS_API}?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Wikimedia Commons search failed (${response.status}).`);
  }
  const payload = (await response.json()) as CommonsResponse;
  if (payload.error?.info) {
    throw new Error(`Wikimedia Commons: ${stripHtml(payload.error.info)}`);
  }
  return parseCommonsPages(payload, expectedKind);
}

/** Searches Commons for playable MIDI files and PDF sheet music in parallel. */
export async function searchOnlineSheets(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<OnlineSheetSearchResult> {
  const cleaned = query.trim();
  if (!cleaned) throw new Error('Enter a sheet name or composer to search for.');
  const limit = options.limit ?? 10;
  const [midi, sheets] = await Promise.all([
    fetchCommonsSearch(`filemime:audio/midi ${cleaned}`, 'midi', limit, options.signal),
    fetchCommonsSearch(`filetype:pdf ${cleaned}`, 'pdf', limit, options.signal),
  ]);
  return { midi, sheets };
}

/** Downloads and parses a MIDI search result into a playable Score. */
export async function importOnlineMidi(result: OnlineSheetResult): Promise<Score> {
  if (result.kind !== 'midi') throw new Error('Only MIDI results can be imported.');
  if (result.sizeBytes > 8 * 1024 * 1024) throw new Error('This MIDI file is too large (8 MB maximum).');
  const response = await fetch(result.fileUrl);
  if (!response.ok) {
    throw new Error(`Could not download the MIDI file (${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  const parsed = await parseScoreFile(`${result.title || 'online-sheet'}.mid`, buffer);
  if (!parsed.notes.length) throw new Error('The downloaded MIDI contains no playable notes.');
  return {
    ...parsed,
    title: result.title || parsed.title,
    composer: result.artist || parsed.composer || 'Wikimedia Commons',
  };
}

/** External sites without a CORS search API — useful as one-click fallbacks. */
export function externalSheetLinks(query: string): Array<{ label: string; url: string }> {
  const cleaned = query.trim();
  const encoded = encodeURIComponent(cleaned);
  return [
    { label: 'MuseScore', url: `https://musescore.com/sheetmusic?text=${encoded}` },
    {
      label: 'IMSLP',
      url: `https://imslp.org/index.php?title=Special:Search&search=${encoded}`,
    },
    {
      label: 'Wikimedia Commons',
      url: `https://commons.wikimedia.org/w/index.php?search=${encoded}&title=Special:MediaSearch&type=image`,
    },
  ];
}
