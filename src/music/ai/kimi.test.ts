import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KIMI_DEFAULT_BASE_URL,
  KIMI_DEFAULT_MODEL,
  DeepSeekError,
  composeWithKimi,
  normalizeKimiBaseUrl,
  searchKimiReferences,
} from './kimi';

function makeScoreJson(): Record<string, unknown> {
  const notes: Array<Record<string, unknown>> = [];
  for (let bar = 0; bar < 8; bar += 1) {
    const start = bar * 4;
    notes.push(
      { midi: 48, start, duration: 1, velocity: 60, hand: 'left' },
      { midi: 55, start, duration: 1, velocity: 58, hand: 'left' },
      { midi: 72, start, duration: 1, velocity: 80, hand: 'right' },
      { midi: 76, start: start + 1, duration: 1.5, velocity: 82, hand: 'right' },
    );
  }
  return {
    title: 'Kimi Nocturne',
    composer: 'Kimi AI',
    key: { fifths: 0, mode: 'minor' },
    tempo: 88,
    timeSignature: { numerator: 4, denominator: 4 },
    bars: 8,
    notes,
  };
}

function mockChat(content: string) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content } }],
      }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('composeWithKimi', () => {
  it('uses Kimi chat completions with JSON mode and Kimi fields', async () => {
    const fetchMock = mockChat(JSON.stringify(makeScoreJson()));
    const result = await composeWithKimi(
      'Compose a Chopin-style nocturne.',
      { apiKey: 'sk-kimi-test', model: 'kimi-k3.1-pro' },
      { style: 'classical', mood: 'dreamy', fallbackTitle: 'Kimi Nocturne', bars: 8 },
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${KIMI_DEFAULT_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-kimi-test');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('kimi-k3.1-pro');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_completion_tokens).toBeGreaterThan(1000);
    expect(body.reasoning_effort).toBe('low');
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(result.meta).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k3.1-pro',
      title: 'Kimi Nocturne',
      keyName: 'A minor',
    });
    expect(result.score.notes.length).toBeGreaterThan(20);
  });

  it('defaults to Kimi K3', async () => {
    const fetchMock = mockChat(JSON.stringify(makeScoreJson()));
    const result = await composeWithKimi('Compose something.', { apiKey: 'sk-kimi-test' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe(KIMI_DEFAULT_MODEL);
    expect(result.meta.model).toBe(KIMI_DEFAULT_MODEL);
  });

  it('normalizes an Anthropic Messages URL to the browser-safe OpenAI endpoint', () => {
    expect(normalizeKimiBaseUrl('https://api.moonshot.cn/anthropic/v1/messages')).toBe(
      'https://api.moonshot.cn/v1',
    );
    expect(normalizeKimiBaseUrl('https://api.moonshot.ai/v1')).toBe(
      'https://api.moonshot.ai/v1',
    );
    expect(normalizeKimiBaseUrl(undefined)).toBe(KIMI_DEFAULT_BASE_URL);
  });

  it('maps Kimi API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'bad key' } }),
      })),
    );
    const error = await composeWithKimi('Compose something.', { apiKey: 'bad' }).catch(
      (err) => err,
    );
    expect(error).toBeInstanceOf(DeepSeekError);
    expect((error as DeepSeekError).status).toBe(401);
    expect((error as Error).message).toMatch(/Kimi.*API key/i);
  });
});

describe('searchKimiReferences', () => {
  it('calls the Kimi Search API and maps search_results', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          search_results: [
            {
              title: 'Shape of You chords',
              url: 'https://example.com/chords',
              snippet: 'Key C# minor; chords C#m F#m A B; 96 BPM.',
              text: '',
            },
            {
              title: 'Piano tutorial',
              url: 'https://example.com/tutorial',
              snippet: 'The hook starts on G#4.',
              text: '',
            },
          ],
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const references = await searchKimiReferences('Shape of You piano chords', {
      apiKey: 'sk-kimi-test',
    });
    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({
      title: 'Shape of You chords',
      url: 'https://example.com/chords',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${KIMI_DEFAULT_BASE_URL}/tools/search`);
    const body = JSON.parse(init.body as string) as {
      text_query: string;
      limit: number;
      timeout_seconds: number;
    };
    expect(body.text_query).toContain('Shape of You');
    expect(body.limit).toBe(5);
    expect(body.timeout_seconds).toBe(20);
  });

  it('surfaces Kimi Search failures and requires a key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => '' })),
    );
    await expect(searchKimiReferences('test', { apiKey: 'bad' })).rejects.toThrow(/Kimi/);
    await expect(searchKimiReferences('test', { apiKey: ' ' })).rejects.toThrow(/Kimi API key/i);
  });
});
