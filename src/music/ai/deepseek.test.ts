import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekError,
  composerStyleGuide,
  composeWithDeepSeek,
  searchDeepSeekReferences,
  type DeepSeekComposeOptions,
} from './deepseek';

const prompt = 'Arrange the pop song "Shape of You" by Ed Sheeran as a solo piano piece.';
const options: DeepSeekComposeOptions = {
  style: 'pop',
  mood: 'happy',
  difficulty: 'medium',
  fallbackTitle: 'Shape of You — Piano',
  bars: 8,
};

function makeScoreJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const notes: Array<Record<string, unknown>> = [];
  for (let bar = 0; bar < 8; bar += 1) {
    const start = bar * 4;
    notes.push(
      { midi: 48, start, duration: 1, velocity: 60, hand: 'left' },
      { midi: 55, start, duration: 1, velocity: 58, hand: 'left' },
      { midi: 60, start: start + 2, duration: 1, velocity: 56, hand: 'left' },
      { midi: 72, start, duration: 1, velocity: 80, hand: 'right' },
      { midi: 76, start: start + 1.5, duration: 1.5, velocity: 82, hand: 'right' },
    );
  }
  return {
    title: 'Shape of You — Piano Arrangement',
    composer: 'DeepSeek AI',
    key: { fifths: 2, mode: 'major' },
    tempo: 96,
    timeSignature: { numerator: 4, denominator: 4 },
    bars: 8,
    notes,
    ...overrides,
  };
}

function mockFetchWith(content: string, status = 200, rawBody?: string) {
  const body =
    rawBody ??
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }],
    });
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('composeWithDeepSeek (free-form)', () => {
  it('sends the free-form prompt in JSON mode with the configured model and key', async () => {
    const fetchMock = mockFetchWith(JSON.stringify(makeScoreJson()));
    await composeWithDeepSeek(
      prompt,
      {
        apiKey: 'sk-test-123',
        model: 'deepseek-flash',
        baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
      },
      options,
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEEPSEEK_DEFAULT_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-123');
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: unknown;
      thinking: unknown;
    };
    expect(body.model).toBe('deepseek-flash');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.messages[0].content).toContain('JSON');
    expect(body.messages[1].content).toContain('Shape of You');
  });

  it('converts valid JSON into a two-hand score and metadata', async () => {
    mockFetchWith(JSON.stringify(makeScoreJson()));
    const result = await composeWithDeepSeek(prompt, { apiKey: 'sk-test' }, options);
    expect(result.score.notes.length).toBeGreaterThan(30);
    expect(result.score.notes.some((note) => note.hand === 'left')).toBe(true);
    expect(result.score.notes.some((note) => note.hand === 'right')).toBe(true);
    expect(result.score.keySignature).toEqual({ fifths: 2, mode: 'major' });
    expect(result.score.tempo[0].bpm).toBe(96);
    expect(result.meta).toMatchObject({
      provider: 'deepseek',
      model: DEEPSEEK_DEFAULT_MODEL,
      style: 'pop',
      mood: 'happy',
      bars: 8,
      title: 'Shape of You — Piano Arrangement',
      keyName: 'D major',
    });
  });

  it('passes web references and a composer style guide to the model', async () => {
    const fetchMock = mockFetchWith(JSON.stringify(makeScoreJson()));
    await composeWithDeepSeek(
      'Write a Chopin-style nocturne.',
      { apiKey: 'sk-test' },
      {
        ...options,
        referenceText: 'Key: E-flat major; chords: Ebmaj7 | Cm7 | Abmaj7 | Bb7.',
        styleGuide: composerStyleGuide('Chopin'),
      },
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    const userPrompt = body.messages[1].content;
    expect(userPrompt).toContain('WEB REFERENCE NOTES');
    expect(userPrompt).toContain('Ebmaj7');
    expect(userPrompt).toContain('STYLE GUIDE');
    expect(userPrompt).toContain('rubato');
  });

  it('accepts string keys and markdown fences', async () => {
    mockFetchWith('```json\n' + JSON.stringify(makeScoreJson({ key: 'D minor' })) + '\n```');
    const result = await composeWithDeepSeek(prompt, { apiKey: 'sk-test' }, options);
    expect(result.score.keySignature).toEqual({ fifths: -1, mode: 'minor' });
    expect(result.meta.keyName).toBe('D minor');
  });

  it('falls back to a C major sketch when the model omits musical metadata', async () => {
    const json = makeScoreJson({ key: undefined, tempo: undefined, timeSignature: undefined });
    mockFetchWith(JSON.stringify(json));
    const result = await composeWithDeepSeek(prompt, { apiKey: 'sk-test' }, options);
    expect(result.score.keySignature).toEqual({ fifths: 0, mode: 'major' });
    expect(result.score.tempo[0].bpm).toBe(90);
    expect(result.score.timeSignatures[0]).toMatchObject({ numerator: 4, denominator: 4 });
  });

  it('throws a clear error when the API rejects the key', async () => {
    mockFetchWith('', 401, JSON.stringify({ error: { message: 'Authentication Fails' } }));
    const error = await composeWithDeepSeek(prompt, { apiKey: 'bad' }, options).catch((err) => err);
    expect(error).toBeInstanceOf(DeepSeekError);
    expect((error as DeepSeekError).status).toBe(401);
    expect((error as Error).message).toMatch(/API key/i);
  });

  it('requires a prompt and a key', async () => {
    await expect(composeWithDeepSeek('   ', { apiKey: 'sk-test' })).rejects.toThrow(
      /Describe the song/i,
    );
    await expect(composeWithDeepSeek(prompt, { apiKey: '   ' })).rejects.toThrow(/API key/i);
  });

  it('rejects JSON without a playable two-hand score', async () => {
    mockFetchWith(
      JSON.stringify(
        makeScoreJson({
          notes: [
            { midi: 72, start: 0, duration: 1 },
            { midi: 74, start: 1, duration: 1 },
          ],
        }),
      ),
    );
    await expect(composeWithDeepSeek(prompt, { apiKey: 'sk-test' }, options)).rejects.toThrow(
      /two-hand/i,
    );
  });

  it('rejects empty and malformed model output', async () => {
    mockFetchWith('', 200, JSON.stringify({ choices: [{ message: { content: '' } }] }));
    await expect(composeWithDeepSeek(prompt, { apiKey: 'sk-test' })).rejects.toThrow(/empty/i);

    mockFetchWith('this is not json');
    await expect(composeWithDeepSeek(prompt, { apiKey: 'sk-test' })).rejects.toThrow(/JSON/i);
  });

  it('maps truncated responses and server errors', async () => {
    mockFetchWith(
      '',
      200,
      JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: '{"notes": [' } }],
      }),
    );
    await expect(composeWithDeepSeek(prompt, { apiKey: 'sk-test' })).rejects.toThrow(/cut off/i);

    mockFetchWith('', 503, JSON.stringify({ error: { message: 'busy' } }));
    await expect(composeWithDeepSeek(prompt, { apiKey: 'sk-test' })).rejects.toMatchObject({
      status: 503,
    });
  });

  it('exposes concrete style guides for common composers', () => {
    expect(composerStyleGuide('Chopin')).toContain('rubato');
    expect(composerStyleGuide('J.S. Bach')).toContain('counterpoint');
    expect(composerStyleGuide('Debussy')).toContain('whole-tone');
    expect(composerStyleGuide('An Unknown Composer')).toBeUndefined();
  });
});

describe('searchDeepSeekReferences', () => {
  const searchPayload = {
    results: [
      {
        title: 'Shape of You chords',
        url: 'https://example.com/shape',
        summary: 'Key: C# minor. Chords: C#m | F#m | A | B. Tempo 96 BPM.',
        snippet: 'ignored',
      },
      {
        title: 'Shape of You piano tutorial',
        url: 'https://example.com/tutorial',
        summary: 'The vocal hook begins on the tonic and descends to the fifth.',
      },
    ],
  };

  it('calls the DeepSeek Search API and maps results', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(searchPayload),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const references = await searchDeepSeekReferences(
      'Shape of You piano chords',
      { apiKey: 'sk-test' },
    );
    expect(references).toHaveLength(2);
    expect(references[0]).toMatchObject({
      title: 'Shape of You chords',
      url: 'https://example.com/shape',
    });
    expect(references[0].summary).toContain('C# minor');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string) as {
      query: string;
      count: number;
      need_content: boolean;
    };
    expect(body.query).toContain('Shape of You');
    expect(body.count).toBe(5);
    expect(body.need_content).toBe(false);
  });

  it('surfaces search authentication failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'bad key' } }),
      })),
    );
    const error = await searchDeepSeekReferences('test', { apiKey: 'bad' }).catch((err) => err);
    expect(error).toBeInstanceOf(DeepSeekError);
    expect((error as DeepSeekError).status).toBe(401);
  });

  it('rejects empty queries and keys', async () => {
    await expect(searchDeepSeekReferences('   ', { apiKey: 'sk-test' })).rejects.toThrow(
      /song or composer/i,
    );
    await expect(searchDeepSeekReferences('test', { apiKey: '  ' })).rejects.toThrow(/API key/i);
  });
});
