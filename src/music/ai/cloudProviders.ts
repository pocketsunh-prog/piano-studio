/** Shared configuration for the two cloud piano providers. */
import type { AiComposition } from './composer';
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_MODELS,
  composeWithDeepSeek,
  searchDeepSeekReferences,
  type DeepSeekComposeOptions,
  type DeepSeekConfig,
  type DeepSeekReference,
} from './deepseek';
import {
  KIMI_DEFAULT_BASE_URL,
  KIMI_DEFAULT_MODEL,
  KIMI_MODELS,
  composeWithKimi,
  searchKimiReferences,
} from './kimi';
import type { CloudProviderId } from './deepseekSettings';

export interface CloudProviderConfig {
  id: CloudProviderId;
  label: string;
  title: string;
  eyebrow: string;
  subtitle: string;
  keyLink: string;
  keyHost: string;
  defaultBaseUrl: string;
  defaultModel: string;
  models: ReadonlyArray<{ value: string; label: string }>;
  compose: (
    prompt: string,
    config: DeepSeekConfig,
    options: DeepSeekComposeOptions,
    signal?: AbortSignal,
  ) => Promise<AiComposition>;
  search: (
    query: string,
    config: DeepSeekConfig,
    signal?: AbortSignal,
  ) => Promise<DeepSeekReference[]>;
  searchName: string;
  modelHint: string;
  migrateFlash: boolean;
  /** Kimi's standalone Search endpoint is not browser-CORS-enabled. */
  supportsSearch: boolean;
}

export const CLOUD_PROVIDERS: Record<CloudProviderId, CloudProviderConfig> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    title: 'DeepSeek piano sheet',
    eyebrow: 'DEEPSEEK AI · CLOUD ARRANGER',
    subtitle:
      'Just type a song to arrange, or a sheet title and composer to write in their style. No style, key or tempo controls — DeepSeek decides.',
    keyLink: 'https://platform.deepseek.com/api_keys',
    keyHost: 'api.deepseek.com',
    defaultBaseUrl: DEEPSEEK_DEFAULT_BASE_URL,
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
    models: DEEPSEEK_MODELS,
    compose: composeWithDeepSeek,
    search: searchDeepSeekReferences,
    searchName: 'DeepSeek Search',
    modelHint: 'V4 Pro is recommended for closer song and composer results.',
    migrateFlash: true,
    supportsSearch: true,
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    title: 'Kimi piano sheet',
    eyebrow: 'KIMI AI · CLOUD ARRANGER',
    subtitle:
      'Just type a song to arrange, or a sheet title and composer to write in their style. No style, key or tempo controls — Kimi decides.',
    keyLink: 'https://platform.kimi.ai/console/api-keys',
    keyHost: 'api.moonshot.ai',
    defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
    defaultModel: KIMI_DEFAULT_MODEL,
    models: KIMI_MODELS,
    compose: composeWithKimi,
    search: searchKimiReferences,
    searchName: 'Kimi Search',
    modelHint: 'K3.1 Pro is recommended; Highspeed is faster but may be less detailed.',
    migrateFlash: false,
    supportsSearch: false,
  },
};
