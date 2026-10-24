import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DeepSeekError,
  composeWithDeepSeek,
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
      model: 'deepseek-flash',
      style: 'pop',
      mood: 'happy',
      bars: 8,
      title: 'Shape of You — Piano Arrangement',
      keyName: 'D major',
    });
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
});
