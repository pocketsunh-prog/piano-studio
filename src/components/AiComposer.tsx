import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AI_DIFFICULTIES,
  AI_EXAMPLE_PROMPTS,
  AI_KEY_ROOTS,
  AI_MOODS,
  AI_STYLES,
  AI_TIME_SIGNATURES,
  aiKeyName,
  composePianoPiece,
  type AiComposition,
  type AiDifficulty,
  type AiMood,
  type AiStyle,
  type AiTimeSignature,
} from '../music/ai/composer';
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_MODELS,
  composeWithDeepSeek,
} from '../music/ai/deepseek';
import { parsePrompt } from '../music/ai/prompt';

export interface AiComposerProps {
  onClose: () => void;
  onCreate: (composition: AiComposition) => void;
}

type AiProvider = 'local' | 'deepseek';

interface StoredSettings {
  provider?: AiProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  remember?: boolean;
}

const STORAGE_KEY = 'piano-studio.deepseek.v1';
const BARS_OPTIONS = [8, 16, 24, 32];

const DEFAULT_OPTIONS = {
  style: 'romantic' as AiStyle,
  mood: 'dreamy' as AiMood,
  keyRoot: 9,
  mode: 'minor' as const,
  bars: 16,
  bpm: 76,
  timeSignature: '4/4' as AiTimeSignature,
  difficulty: 'medium' as AiDifficulty,
  seed: 20261024,
};

function loadSettings(): StoredSettings {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as StoredSettings;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* ignore unavailable storage */
    }
  }
  return {};
}

function styleLabel(style: AiStyle): string {
  return AI_STYLES.find((entry) => entry.value === style)?.label ?? style;
}

function moodLabel(mood: AiMood): string {
  return AI_MOODS.find((entry) => entry.value === mood)?.label ?? mood;
}

export function AiComposer({ onClose, onCreate }: AiComposerProps) {
  const [stored] = useState<StoredSettings>(loadSettings);
  const [provider, setProvider] = useState<AiProvider>(
    stored.provider === 'deepseek' ? 'deepseek' : 'local',
  );
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<AiStyle>(DEFAULT_OPTIONS.style);
  const [mood, setMood] = useState<AiMood>(DEFAULT_OPTIONS.mood);
  const [keyRoot, setKeyRoot] = useState(DEFAULT_OPTIONS.keyRoot);
  const [mode, setMode] = useState<'major' | 'minor'>(DEFAULT_OPTIONS.mode);
  const [bars, setBars] = useState(DEFAULT_OPTIONS.bars);
  const [bpm, setBpm] = useState(DEFAULT_OPTIONS.bpm);
  const [timeSignature, setTimeSignature] = useState<AiTimeSignature>(
    DEFAULT_OPTIONS.timeSignature,
  );
  const [difficulty, setDifficulty] = useState<AiDifficulty>(DEFAULT_OPTIONS.difficulty);
  const [seed, setSeed] = useState(DEFAULT_OPTIONS.seed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiComposition>(() =>
    composePianoPiece(DEFAULT_OPTIONS),
  );

  const [apiKey, setApiKey] = useState(stored.apiKey ?? '');
  const [model, setModel] = useState(stored.model ?? DEEPSEEK_DEFAULT_MODEL);
  const [baseUrl, setBaseUrl] = useState(stored.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
  const [rememberKey, setRememberKey] = useState(Boolean(stored.remember));
  const [showKey, setShowKey] = useState(false);

  const promptRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const parsed = useMemo(() => parsePrompt(prompt), [prompt]);

  // Persist provider settings; the key is only remembered on request.
  useEffect(() => {
    try {
      const payload = JSON.stringify({
        provider,
        apiKey,
        model,
        baseUrl,
        remember: rememberKey,
      });
      const target = rememberKey ? localStorage : sessionStorage;
      const other = rememberKey ? sessionStorage : localStorage;
      target.setItem(STORAGE_KEY, payload);
      other.removeItem(STORAGE_KEY);
    } catch {
      /* storage can be full or blocked */
    }
  }, [provider, apiKey, model, baseUrl, rememberKey]);

  useEffect(() => {
    promptRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [onClose]);

  useEffect(() => {
    if (provider === 'deepseek' && bars > 16) setBars(16);
  }, [provider, bars]);

  const detected = useMemo(() => {
    const items: string[] = [];
    if (parsed.style) items.push(styleLabel(parsed.style));
    if (parsed.mood) items.push(moodLabel(parsed.mood));
    if (parsed.keyRoot !== undefined) {
      items.push(aiKeyName(parsed.keyRoot, parsed.mode ?? mode));
    }
    if (parsed.bars) items.push(`${parsed.bars} bars`);
    if (parsed.bpm) items.push(`${parsed.bpm} BPM`);
    if (parsed.timeSignature) items.push(parsed.timeSignature);
    if (parsed.difficulty) items.push(`${parsed.difficulty} difficulty`);
    return items;
  }, [parsed, mode]);

  const chooseProvider = (next: AiProvider) => {
    setProvider(next);
    setError(null);
    if (next === 'deepseek' && bars > 16) setBars(16);
  };

  const generate = async (overridePrompt?: string) => {
    if (busy) return;
    const text = overridePrompt ?? prompt;
    const spec = parsePrompt(text);
    const nextStyle = spec.style ?? style;
    const nextMood = spec.mood ?? mood;
    const nextKeyRoot = spec.keyRoot ?? keyRoot;
    const nextMode = spec.mode ?? mode;
    const nextBarsRaw = spec.bars ?? bars;
    const nextBars = provider === 'deepseek' ? Math.min(16, nextBarsRaw) : nextBarsRaw;
    const nextTimeSignature =
      spec.timeSignature ?? (nextStyle === 'waltz' ? '3/4' : timeSignature);
    const nextDifficulty = spec.difficulty ?? difficulty;
    const nextBpm = spec.bpm ?? bpm;
    const nextSeed = Math.floor(Math.random() * 0x7fffffff);

    setStyle(nextStyle);
    setMood(nextMood);
    setKeyRoot(nextKeyRoot);
    setMode(nextMode);
    setBars(nextBars);
    setTimeSignature(nextTimeSignature);
    setDifficulty(nextDifficulty);
    setBpm(nextBpm);
    setSeed(nextSeed);
    setBusy(true);
    setError(null);

    if (provider === 'deepseek') {
      if (!apiKey.trim()) {
        setBusy(false);
        setError('Enter your DeepSeek API key, or switch to the local composer.');
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const composition = await composeWithDeepSeek(
          {
            prompt: text,
            style: nextStyle,
            mood: nextMood,
            keyRoot: nextKeyRoot,
            mode: nextMode,
            bars: nextBars,
            bpm: nextBpm,
            timeSignature: nextTimeSignature,
            difficulty: nextDifficulty,
          },
          { apiKey, model, baseUrl },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setResult(composition);
          setSeed(composition.meta.seed);
        }
      } catch (generationError) {
        if (!controller.signal.aborted) {
          setError(
            generationError instanceof Error
              ? generationError.message
              : 'DeepSeek generation failed.',
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(false);
        }
      }
      return;
    }

    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const composition = composePianoPiece({
        style: nextStyle,
        mood: nextMood,
        keyRoot: nextKeyRoot,
        mode: nextMode,
        bars: nextBars,
        bpm: nextBpm,
        timeSignature: nextTimeSignature,
        difficulty: nextDifficulty,
        seed: nextSeed,
      });
      setResult(composition);
      setBusy(false);
    }, 220);
  };

  const surprise = () => {
    const example = AI_EXAMPLE_PROMPTS[Math.floor(Math.random() * AI_EXAMPLE_PROMPTS.length)];
    setPrompt(example);
    void generate(example);
  };

  const applyStyle = (value: AiStyle) => {
    setStyle(value);
    if (value === 'waltz') setTimeSignature('3/4');
    if (value === 'ambient') setMood('dreamy');
  };

  const busyLabel = busy
    ? provider === 'deepseek'
      ? 'DeepSeek is composing…'
      : 'Composing…'
    : provider === 'deepseek'
      ? '✦ Generate with DeepSeek'
      : '✦ Generate piano sheet';

  return (
    <div
      className="ai-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="ai-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-composer-title"
      >
        <header className="ai-header">
          <div>
            <p className="ai-eyebrow">Generative piano sheet · local or DeepSeek</p>
            <h2 id="ai-composer-title">AI piano sheet</h2>
            <p className="ai-subtitle">
              Describe a piece or pick the controls, then generate a two-hand piano score you can
              listen to, play and export.
            </p>
          </div>
          <button type="button" className="ai-close" onClick={onClose} aria-label="Close AI composer">
            ×
          </button>
        </header>

        <div className="ai-body">
          <div className="ai-form">
            <div className="ai-provider">
              <div className="ai-seg" role="group" aria-label="Generation provider">
                <button
                  type="button"
                  className={provider === 'local' ? 'on' : ''}
                  onClick={() => chooseProvider('local')}
                >
                  Local composer
                </button>
                <button
                  type="button"
                  className={provider === 'deepseek' ? 'on' : ''}
                  onClick={() => chooseProvider('deepseek')}
                >
                  DeepSeek API
                </button>
              </div>
              <span className="ai-provider-note">
                {provider === 'local'
                  ? 'Offline, deterministic, no API key.'
                  : 'Uses your API key directly from this browser.'}
              </span>
            </div>

            {provider === 'deepseek' ? (
              <div className="ai-deepseek-panel">
                <label className="ai-field" htmlFor="deepseek-key">
                  <span>DeepSeek API key</span>
                  <div className="ai-key-row">
                    <input
                      id="deepseek-key"
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder="sk-…"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button type="button" className="ghost" onClick={() => setShowKey((value) => !value)}>
                      {showKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </label>
                <div className="ai-deepseek-row">
                  <label className="ai-field">
                    <span>Model</span>
                    <select value={model} onChange={(event) => setModel(event.target.value)}>
                      {DEEPSEEK_MODELS.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ai-check">
                    <input
                      type="checkbox"
                      checked={rememberKey}
                      onChange={(event) => setRememberKey(event.target.checked)}
                    />
                    Remember on this device
                  </label>
                </div>
                <details className="ai-advanced">
                  <summary>Advanced · API base URL</summary>
                  <label className="ai-field">
                    <span>Base URL</span>
                    <input
                      type="url"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder={DEEPSEEK_DEFAULT_BASE_URL}
                      spellCheck={false}
                    />
                  </label>
                </details>
                <div className="ai-deepseek-links">
                  <a
                    href="https://platform.deepseek.com/api_keys"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get a DeepSeek API key ↗
                  </a>
                  <span>
                    Key &amp; prompts go directly to api.deepseek.com. DeepSeek usage is billed to
                    your account. Remembering stores the key on this device only.
                  </span>
                </div>
              </div>
            ) : null}

            <label className="ai-prompt-label" htmlFor="ai-prompt">
              Describe your piece
            </label>
            <div className="ai-prompt-row">
              <input
                id="ai-prompt"
                ref={promptRef}
                type="text"
                value={prompt}
                placeholder="e.g. dreamy waltz in A minor, 16 bars, slow"
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void generate();
                }}
              />
              <button type="button" className="ai-surprise" onClick={surprise}>
                ✨ Surprise me
              </button>
            </div>
            <div className="ai-examples">
              {AI_EXAMPLE_PROMPTS.slice(0, 3).map((example) => (
                <button
                  key={example}
                  type="button"
                  className="ai-chip"
                  onClick={() => {
                    setPrompt(example);
                    void generate(example);
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
            <div className="ai-detected">
              {prompt.trim() ? (
                detected.length ? (
                  <>
                    <span className="ai-detected-label">Detected</span>
                    {detected.map((item) => (
                      <span key={item} className="ai-detected-chip">
                        {item}
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="ai-detected-empty">
                    No specific settings detected — using the controls below.
                  </span>
                )
              ) : (
                <span className="ai-detected-empty">
                  Try a style, mood, key, length, BPM or meter in the prompt.
                </span>
              )}
            </div>

            {error ? (
              <div className="ai-error" role="alert">
                <span>{error}</span>
                {provider === 'deepseek' ? (
                  <button type="button" className="ghost" onClick={() => chooseProvider('local')}>
                    Use local composer
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="ai-grid">
              <label className="ai-field">
                <span>Style</span>
                <select
                  value={style}
                  onChange={(event) => applyStyle(event.target.value as AiStyle)}
                >
                  {AI_STYLES.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="ai-field">
                <span>Mood</span>
                <select
                  value={mood}
                  onChange={(event) => setMood(event.target.value as AiMood)}
                >
                  {AI_MOODS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="ai-field">
                <span>Key</span>
                <select
                  value={keyRoot}
                  onChange={(event) => setKeyRoot(Number(event.target.value))}
                >
                  {AI_KEY_ROOTS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="ai-field">
                <span>Mode</span>
                <div className="ai-seg" role="group" aria-label="Mode">
                  {(['major', 'minor'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={mode === value ? 'on' : ''}
                      onClick={() => setMode(value)}
                    >
                      {value === 'major' ? 'Major' : 'Minor'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="ai-field ai-field-wide">
                <span>Length</span>
                <div className="ai-seg" role="group" aria-label="Length in bars">
                  {BARS_OPTIONS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={bars === value ? 'on' : ''}
                      onClick={() => setBars(value)}
                      disabled={provider === 'deepseek' && value > 16}
                    >
                      {value} bars
                    </button>
                  ))}
                </div>
                {provider === 'deepseek' ? (
                  <small className="ai-field-note">
                    DeepSeek generation is capped at 16 bars per request.
                  </small>
                ) : null}
              </div>

              <div className="ai-field">
                <span>Difficulty</span>
                <div className="ai-seg" role="group" aria-label="Difficulty">
                  {AI_DIFFICULTIES.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      className={difficulty === entry.value ? 'on' : ''}
                      onClick={() => setDifficulty(entry.value)}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="ai-field">
                <span>Meter</span>
                <div className="ai-seg" role="group" aria-label="Time signature">
                  {AI_TIME_SIGNATURES.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      className={timeSignature === entry.value ? 'on' : ''}
                      onClick={() => setTimeSignature(entry.value)}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="ai-field ai-tempo">
                <span>Tempo</span>
                <div className="ai-tempo-row">
                  <input
                    type="range"
                    min={50}
                    max={160}
                    step={1}
                    value={bpm}
                    onChange={(event) => setBpm(Number(event.target.value))}
                  />
                  <strong>{bpm} BPM</strong>
                </div>
              </label>
            </div>

            <button type="button" className="primary ai-generate" onClick={() => void generate()} disabled={busy}>
              {busyLabel}
            </button>
          </div>

          <aside className={`ai-preview ${busy ? 'is-busy' : ''}`} aria-live="polite">
            <p className="ai-eyebrow">Generated sheet</p>
            <h3>{result.meta.title}</h3>
            <p className="ai-description">{result.meta.description}</p>
            <div className="ai-meta">
              <span>
                {result.meta.provider === 'deepseek'
                  ? `DeepSeek${result.meta.model ? ` · ${result.meta.model}` : ''}`
                  : 'Local composer'}
              </span>
              <span>{styleLabel(result.meta.style)}</span>
              <span>{moodLabel(result.meta.mood)}</span>
              <span>{result.meta.keyName}</span>
              <span>{result.meta.timeSignature}</span>
              <span>{result.meta.bars} bars</span>
              <span>{result.meta.bpm} BPM</span>
              <span>{result.score.notes.length} notes</span>
              {result.meta.provider !== 'deepseek' ? (
                <span className="ai-seed">seed {seed}</span>
              ) : null}
            </div>
            <div className="ai-preview-actions">
              <button
                type="button"
                className="primary"
                onClick={() => onCreate(result)}
                disabled={busy}
              >
                Open in Studio
              </button>
              <button type="button" className="ghost" onClick={() => void generate()} disabled={busy}>
                ↻ Regenerate
              </button>
            </div>
            <p className="ai-hint">
              Opens in the sheet view — press <strong>Listen</strong> to hear it, practice with the
              keyboard, or export MusicXML/MIDI.
            </p>
            <p className="ai-local-note">
              {result.meta.provider === 'deepseek'
                ? 'This piece was composed by DeepSeek and validated locally into a playable score. Your API key is never sent anywhere except DeepSeek.'
                : 'Generated on this device by Piano Studio’s local composer; no cloud AI or API key is used.'}
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}
