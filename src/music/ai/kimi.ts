/**
 * Kimi (Moonshot AI) provider.
 *
 * Kimi's Chat Completions API is OpenAI-compatible and browser-CORS-friendly.
 * It shares the piano JSON prompt/validation pipeline with DeepSeek, but uses
 * Kimi's model names, request fields and web-search endpoint.
 */
import {
  DeepSeekError,
  composeWithDeepSeek,
  type DeepSeekComposeOptions,
  type DeepSeekConfig,
  type DeepSeekReference,
} from './deepseek';

export { DeepSeekError };

export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

export const KIMI_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro — best arrangements' },
  { value: 'kimi-k3.1-pro-highspeed', label: 'Kimi K3.1 Pro Highspeed — faster' },
  { value: 'kimi-k3', label: 'Kimi K3 — previous flagship' },
];

export const KIMI_DEFAULT_MODEL = 'kimi-k3.1-pro';

export type KimiConfig = DeepSeekConfig;
export type KimiComposeOptions = DeepSeekComposeOptions;

export async function composeWithKimi(
  prompt: string,
  config: KimiConfig,
  options: KimiComposeOptions = {},
  externalSignal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof composeWithDeepSeek>>> {
  return composeWithDeepSeek(
    prompt,
    { ...config, baseUrl: config.baseUrl?.trim() || KIMI_DEFAULT_BASE_URL },
    options,
    externalSignal,
    'kimi',
  );
}

function searchEndpointFor(baseUrl: string | undefined): string {
  let base = (baseUrl?.trim() || KIMI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/, '');
  if (base.endsWith('/v1')) return `${base}/tools/search`;
  return `${base}/v1/tools/search`;
}

interface KimiSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  text?: string;
}

interface KimiSearchResponse {
  search_results?: KimiSearchResult[];
  error?: { message?: string };
}

function kimiSearchError(status: number, payload: KimiSearchResponse | null): string {
  const message = payload?.error?.message?.trim();
  if (status === 401) return 'Kimi rejected the API key (401). Check the key on platform.kimi.ai.';
  if (status === 403) return 'Kimi refused the Search request (403). Check the account status.';
  if (status === 429) return 'Kimi rate limit reached (429). Wait a moment and retry.';
  if (status === 504) return 'Kimi Search timed out (504). Try a simpler query.';
  if (status >= 500) return `Kimi Search is temporarily unavailable (${status}).`;
  return message ? `Kimi Search error ${status}: ${message}` : `Kimi Search failed (${status}).`;
}

/**
 * Looks up public song/style references through Kimi's Web Search Basic API.
 * Failures are non-fatal; the caller can compose from model knowledge.
 */
export async function searchKimiReferences(
  query: string,
  config: KimiConfig,
  externalSignal?: AbortSignal,
): Promise<DeepSeekReference[]> {
  const cleaned = query.replace(/\s+/g, ' ').trim().slice(0, 120);
  const apiKey = config.apiKey.trim();
  if (!cleaned) throw new DeepSeekError('Enter a song or composer to look up.');
  if (!apiKey) throw new DeepSeekError('Enter your Kimi API key first.');

  const endpoint = searchEndpointFor(config.baseUrl);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 45_000);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        text_query: cleaned,
        limit: 5,
        timeout_seconds: 20,
      }),
      signal: controller.signal,
    });
  } catch {
    if (externalSignal?.aborted) throw new DeepSeekError('Kimi reference lookup was cancelled.');
    if (controller.signal.aborted) {
      throw new DeepSeekError('Kimi reference lookup timed out.');
    }
    throw new DeepSeekError(`Could not reach the Kimi Search API at ${endpoint}.`);
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }

  let payload: KimiSearchResponse | null = null;
  try {
    const text = await response.text();
    payload = text ? (JSON.parse(text) as KimiSearchResponse) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new DeepSeekError(kimiSearchError(response.status, payload), response.status);
  }

  const references: DeepSeekReference[] = [];
  for (const result of payload?.search_results ?? []) {
    const title = (result.title ?? '').trim();
    const summary = (result.snippet || result.text || '').replace(/\s+/g, ' ').trim();
    if (!title || !summary) continue;
    references.push({
      title: title.slice(0, 120),
      url: (result.url ?? '').slice(0, 400),
      summary: summary.slice(0, 900),
    });
    if (references.length >= 5) break;
  }
  return references;
}
