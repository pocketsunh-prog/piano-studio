import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScore } from '../score';
import { writeMidi } from '../formats/midi';
import {
  externalSheetLinks,
  importOnlineMidi,
  parseCommonsPages,
  searchOnlineSheets,
  type OnlineSheetResult,
} from './commons';

const midiPayload = {
  query: {
    pages: {
      '2': {
        title: 'File:Twinkle_Twinkle_in_fifths.mid',
        index: 2,
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/5/5e/Twinkle.mid?utm_source=x',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Twinkle_Twinkle_in_fifths.mid',
            mime: 'audio/midi',
            size: 1991,
            extmetadata: {
              Artist: { value: '<a href="#">Traditional</a>' },
              LicenseShortName: { value: 'Public domain' },
            },
          },
        ],
      },
      '1': {
        title: 'File:Twinkle_sheet.pdf',
        index: 1,
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Twinkle_sheet.pdf',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Twinkle_sheet.pdf',
            mime: 'application/pdf',
            size: 42000,
            thumburl: 'https://upload.wikimedia.org/thumb.jpg',
          },
        ],
      },
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseCommonsPages', () => {
  it('converts and filters Commons imageinfo results', () => {
    const midi = parseCommonsPages(midiPayload, 'midi');
    expect(midi).toHaveLength(1);
    expect(midi[0]).toMatchObject({
      title: 'Twinkle Twinkle in fifths',
      kind: 'midi',
      mime: 'audio/midi',
      fileUrl: 'https://upload.wikimedia.org/wikipedia/commons/5/5e/Twinkle.mid',
      artist: 'Traditional',
      license: 'Public domain',
    });

    const pdf = parseCommonsPages(midiPayload, 'pdf');
    expect(pdf).toHaveLength(1);
    expect(pdf[0]).toMatchObject({
      title: 'Twinkle sheet',
      kind: 'pdf',
      thumbnailUrl: 'https://upload.wikimedia.org/thumb.jpg',
    });
  });

  it('returns an empty list for missing pages', () => {
    expect(parseCommonsPages({}, 'midi')).toEqual([]);
    expect(parseCommonsPages({ query: {} }, 'pdf')).toEqual([]);
  });
});

describe('searchOnlineSheets', () => {
  it('queries MIDI and PDF searches and merges the results', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => midiPayload,
        };
      }),
    );
    const result = await searchOnlineSheets('twinkle');
    expect(result.midi).toHaveLength(1);
    expect(result.sheets).toHaveLength(1);
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.includes('filemime%3Aaudio%2Fmidi'))).toBe(true);
    expect(urls.some((url) => url.includes('filetype%3Apdf'))).toBe(true);
    expect(urls.every((url) => url.includes('origin=*'))).toBe(true);
  });

  it('rejects an empty query', async () => {
    await expect(searchOnlineSheets('  ')).rejects.toThrow(/sheet name/i);
  });

  it('surfaces API failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    await expect(searchOnlineSheets('bach')).rejects.toThrow(/503/);
  });
});

describe('importOnlineMidi', () => {
  it('downloads a MIDI result and parses it into a Score', async () => {
    const source = createScore({
      title: 'Source',
      notes: [
        { id: 'a', midi: 60, start: 0, duration: 1, velocity: 80, hand: 'right' },
        { id: 'b', midi: 48, start: 0, duration: 2, velocity: 70, hand: 'left' },
      ],
      lengthBeats: 4,
    });
    const bytes = writeMidi(source);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const fetchedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        fetchedUrls.push(String(input));
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => buffer,
        };
      }),
    );

    const result: OnlineSheetResult = {
      id: 'commons-1',
      title: 'Twinkle Twinkle',
      pageTitle: 'File:Twinkle.mid',
      fileUrl: 'https://upload.wikimedia.org/Twinkle.mid',
      descriptionUrl: 'https://commons.wikimedia.org/wiki/File:Twinkle.mid',
      mime: 'audio/midi',
      sizeBytes: 2000,
      kind: 'midi',
      artist: 'Traditional',
    };
    const score = await importOnlineMidi(result);
    expect(fetchedUrls).toEqual([result.fileUrl]);
    expect(score.notes.length).toBe(2);
    expect(score.title).toBe('Twinkle Twinkle');
    expect(score.composer).toBe('Traditional');
  });

  it('rejects non-MIDI results', async () => {
    const result: OnlineSheetResult = {
      id: 'x',
      title: 'Sheet',
      pageTitle: 'File:Sheet.pdf',
      fileUrl: 'https://example.com/sheet.pdf',
      descriptionUrl: 'https://example.com',
      mime: 'application/pdf',
      sizeBytes: 100,
      kind: 'pdf',
    };
    await expect(importOnlineMidi(result)).rejects.toThrow(/Only MIDI/i);
  });
});

describe('externalSheetLinks', () => {
  it('encodes the query for MuseScore and IMSLP', () => {
    const links = externalSheetLinks('Clair de Lune');
    expect(links[0].url).toContain('musescore.com');
    expect(links[0].url).toContain('Clair%20de%20Lune');
    expect(links[1].url).toContain('imslp.org');
    expect(links[1].url).toContain('Clair%20de%20Lune');
  });
});
