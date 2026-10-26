/** Persistence for cloud AI provider keys/settings. */
export type CloudProviderId = 'deepseek' | 'kimi';

export interface CloudSettings {
  provider?: CloudProviderId;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  remember?: boolean;
  /** Set after the one-time switch to a stronger default model. */
  modelMigrated?: boolean;
}

const STORAGE_KEYS: Record<CloudProviderId, string> = {
  deepseek: 'piano-studio.deepseek.v1',
  kimi: 'piano-studio.kimi.v1',
};

export function loadCloudSettings(provider: CloudProviderId): CloudSettings {
  const key = STORAGE_KEYS[provider];
  for (const store of [localStorage, sessionStorage]) {
    try {
      const raw = store.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as CloudSettings;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* storage unavailable or contains stale data */
    }
  }
  return {};
}

export function saveCloudSettings(provider: CloudProviderId, settings: CloudSettings): void {
  const key = STORAGE_KEYS[provider];
  try {
    const payload = JSON.stringify(settings);
    const target = settings.remember ? localStorage : sessionStorage;
    const other = settings.remember ? sessionStorage : localStorage;
    target.setItem(key, payload);
    other.removeItem(key);
  } catch {
    /* storage can be full or blocked */
  }
}

/** Backwards-compatible DeepSeek helpers. */
export function loadDeepSeekSettings(): CloudSettings {
  return loadCloudSettings('deepseek');
}

export function saveDeepSeekSettings(settings: CloudSettings): void {
  saveCloudSettings('deepseek', settings);
}
