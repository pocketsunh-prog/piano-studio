/** Persistence for the DeepSeek API key/model, shared by the cloud composer UI. */
export interface DeepSeekSettings {
  provider?: 'local' | 'deepseek';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  remember?: boolean;
  /** Set after the one-time switch to V4 Pro for better arrangements. */
  modelMigrated?: boolean;
}

const STORAGE_KEY = 'piano-studio.deepseek.v1';

export function loadDeepSeekSettings(): DeepSeekSettings {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as DeepSeekSettings;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* storage unavailable or contains stale data */
    }
  }
  return {};
}

export function saveDeepSeekSettings(settings: DeepSeekSettings): void {
  try {
    const payload = JSON.stringify(settings);
    const target = settings.remember ? localStorage : sessionStorage;
    const other = settings.remember ? sessionStorage : localStorage;
    target.setItem(STORAGE_KEY, payload);
    other.removeItem(STORAGE_KEY);
  } catch {
    /* storage can be full or blocked */
  }
}
