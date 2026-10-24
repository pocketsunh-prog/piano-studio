import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DeepSeekError,
  composeWithDeepSeek,
  type DeepSeekComposeRequest,
} from './deepseek';

const request: DeepSeekComposeRequest = {
  prompt: 'dreamy waltz in A minor, 16 bars',
  style: 'waltz',
  mood: 'dreamy',
  keyRoot: 9,
  mode: 'minor',
  bars: 24,
  bpm: 84,
  timeSignature: '3/4',
  difficulty: 'medium',
};

function makeScoreJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const notes: Array<Record<string, unknown>> = [];
  for (let bar = 0; bar < 16; bar += 1) {
    const start = bar * 3;
    notes.push(
      { midi: 45, start, duration: 1, velocity: 60, hand: 'left' },
      { midi: 52, start, duration: 1, velocity: 58, hand: 'left' },
      { midi: 57, start: start + 1, duration: 1, velocity: 56, hand: 'left' },
      { midi: 72, start, duration: 1, velocity: 80, hand: 'right' },
      { midi: 76, start: start + 1.5, duration: 1.5, velocity: 82, hand: 'right' },
    );
  }
  return {
    title: 'Moonlit Waltz',
    composer: 'DeepSeek AI',
    key: { fifths: 0, mode: 'minor' },
    tempo: 90,
    timeSignature: { numerator: 3, denominator: 4 },
    bars: 16,
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

describe('composeWithDeepSeek', () => {
  it('sends a JSON-mode chat request with the configured model and key', async () => {
    const fetchMock = mockFetchWith(JSON.stringify(makeScoreJson()));
    const result = await composeWithDeepSeek(request, {
      apiKey: 'sk-test-123',
      model: 'deepseek-flash',
      baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
    });
    expect(result.meta.provider).toBe('deepseek');
    expect(result.meta.model).toBe('deepseek-flash');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEEPSEEK_DEFAULT_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-123');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-flash');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
    expect((body.messages as Array<{ content: string }>)[0].content).toContain('JSON');
  });

  it('converts valid JSON into a two-hand score and clamps bars for cloud output', async () => {
    mockFetchWith(JSON.stringify(makeScoreJson()));
    const result = await composeWithDeepSeek(request, {
      apiKey: 'sk-test',
      model: 'deepseek-flash',
    });
    expect(result.score.notes.length).toBeGreaterThan(50);
    expect(result.score.notes.some((note) => note.hand === 'left')).toBe(true);
    expect(result.score.notes.some((note) => note.hand === 'right')).toBe(true);
    expect(result.score.keySignature).toEqual({ fifths: 0, mode: 'minor' });
    expect(result.score.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
    expect(result.score.tempo[0].bpm).toBe(90);
    expect(result.meta.bars).toBe(16); // DeepSeek is capped at 16 bars
    expect(result.meta.title).toBe('Moonlit Waltz');
    expect(result.meta.keyName).toBe('A minor');
    expect(result.score.composer).toBe('DeepSeek AI');
  });

  it('strips markdown fences and accepts a string key', async () => {
    const json = makeScoreJson({ key: 'D minor' });
    mockFetchWith('```json\n' + JSON.stringify(json) + '\n```');
    const result = await composeWithDeepSeek(request, { apiKey: 'sk-test' });
    expect(result.score.keySignature).toEqual({ fifths: -1, mode: 'minor' });
    expect(result.meta.keyName).toBe('D minor');
  });

  it('throws a clear error when the API rejects the key', async () => {
    mockFetchWith('', 401, JSON.stringify({ error: { message: 'Authentication Fails' } }));
    await expect(composeWithDeepSeek(request, { apiKey: 'bad' })).rejects.toMatchObject({
      name: 'DeepSeekError',
      status: 401,
    });
    await expect(composeWithDeepSeek(request, { apiKey: 'bad' })).rejects.toThrow(/API key/i);
  });

  it('throws when the key is missing', async () => {
    await expect(composeWithDeepSeek(request, { apiKey: '   ' })).rejects.toThrow(/API key/i);
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
    await expect(composeWithDeepSeek(request, { apiKey: 'sk-test' })).rejects.toThrow(
      /two-hand/i,
    );
  });

  it('rejects empty and malformed model output', async () => {
    mockFetchWith('', 200, JSON.stringify({ choices: [{ message: { content: '' } }] }));
    await expect(composeWithDeepSeek(request, { apiKey: 'sk-test' })).rejects.toThrow(/empty/i);

    mockFetchWith('this is not json');
    await expect(composeWithDeepSeek(request, { apiKey: 'sk-test' })).rejects.toThrow(
      /JSON/i,
    );
  });

  it('maps truncated responses and server errors', async () => {
    mockFetchWith(
      '',
      200,
      JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: '{"notes": [' } }],
      }),
    );
    await expect(composeWithDeepSeek(request, { apiKey: 'sk-test' })).rejects.toThrow(/cut off/i);

    mockFetchWith('', 503, JSON.stringify({ error: { message: 'busy' } }));
    await expect(composeWithDeepSeek(request, { apiKey: 'sk-test' })).rejects.toMatchObject({
      status: 503,
    });
  });

  it('exposes DeepSeekError for failures', async () => {
    mockFetchWith('', 429);
    const error = await composeWithDeepSeek(request, { apiKey: 'sk-test' }).catch((err) => err);
    expect(error).toBeInstanceOf(DeepSeekError);
    expect((error as DeepSeekError).status).toBe(429);
  });
});
