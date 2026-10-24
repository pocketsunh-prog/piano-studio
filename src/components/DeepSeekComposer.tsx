import { useEffect, useRef, useState } from 'react';
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_MODELS,
  composeWithDeepSeek,
  type DeepSeekConfig,
} from '../music/ai/deepseek';
import { loadDeepSeekSettings, saveDeepSeekSettings } from '../music/ai/deepseekSettings';
import type { AiComposition } from '../music/ai/composer';

export interface DeepSeekComposerProps {
  onClose: () => void;
  onCreate: (composition: AiComposition) => void;
}

type DeepSeekMode = 'song' | 'composer';

const SONG_EXAMPLES = ['Shape of You — Ed Sheeran', 'Clair de Lune', 'Yesterday — The Beatles'];
const COMPOSER_EXAMPLES: Array<{ title: string; composer: string }> = [
  { title: 'Nocturne in E-flat major', composer: 'Chopin' },
  { title: 'Prelude in C major', composer: 'Bach' },
  { title: 'Waltz for a Rainy Day', composer: 'Debussy' },
];

export function DeepSeekComposer({ onClose, onCreate }: DeepSeekComposerProps) {
  const [stored] = useState(loadDeepSeekSettings);
  const [mode, setMode] = useState<DeepSeekMode>('song');
  const [songQuery, setSongQuery] = useState('');
  const [sheetTitle, setSheetTitle] = useState('');
  const [composerName, setComposerName] = useState('');
  const [apiKey, setApiKey] = useState(stored.apiKey ?? '');
  const [model, setModel] = useState(stored.model ?? DEEPSEEK_DEFAULT_MODEL);
  const [baseUrl, setBaseUrl] = useState(stored.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL);
  const [rememberKey, setRememberKey] = useState(Boolean(stored.remember));
  const [showKey, setShowKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(!stored.apiKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiComposition | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const songRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    saveDeepSeekSettings({ apiKey, model, baseUrl, remember: rememberKey });
  }, [apiKey, model, baseUrl, rememberKey]);

  useEffect(() => {
    songRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      abortRef.current?.abort();
    };
  }, [onClose]);

  const generate = async () => {
    if (busy) return;
    const song = songQuery.trim();
    const title = sheetTitle.trim();
    const composer = composerName.trim();
    if (mode === 'song' && !song) {
      setError('Type a song name to arrange.');
      songRef.current?.focus();
      return;
    }
    if (mode === 'composer' && (!title || !composer)) {
      setError('Enter both a piano sheet name and a composer name.');
      return;
    }
    if (!apiKey.trim()) {
      setError('Enter your DeepSeek API key first.');
      setSettingsOpen(true);
      return;
    }

    const prompt =
      mode === 'song'
        ? `Arrange the song "${song}" as a solo piano piece. If you know the song, use its recognizable melody and chord progression. Write a full two-hand arrangement with the melody in the right hand and accompaniment in the left.`
        : `Compose an original solo piano piece titled "${title}" in the style of ${composer}. Capture that composer’s characteristic harmony, texture, phrasing and form; do not copy an existing composition.`;
    const config: DeepSeekConfig = { apiKey, model, baseUrl };
    const options =
      mode === 'song'
        ? {
            style: 'pop' as const,
            mood: 'happy' as const,
            difficulty: 'medium' as const,
            fallbackTitle: `${song} (Piano Arrangement)`,
            bars: 16,
          }
        : {
            style: 'classical' as const,
            mood: 'dreamy' as const,
            difficulty: 'medium' as const,
            fallbackTitle: title,
            bars: 16,
          };

    setBusy(true);
    setError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const composition = await composeWithDeepSeek(prompt, config, options, controller.signal);
      if (!controller.signal.aborted) setResult(composition);
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
  };

  return (
    <div
      className="ai-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="ai-dialog deepseek-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deepseek-title"
      >
        <header className="ai-header">
          <div>
            <p className="ai-eyebrow">DeepSeek AI · cloud arranger</p>
            <h2 id="deepseek-title">DeepSeek piano sheet</h2>
            <p className="ai-subtitle">
              Just type a song to arrange, or a sheet title and composer to write in their style.
              No style, key or tempo controls — DeepSeek decides.
            </p>
          </div>
          <button type="button" className="ai-close" onClick={onClose} aria-label="Close DeepSeek composer">
            ×
          </button>
        </header>

        <div className="ai-body">
          <div className="ai-form">
            <details
              className="deepseek-settings"
              open={settingsOpen}
              onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
            >
              <summary>
                DeepSeek API settings
                <span className={apiKey ? 'settings-ok' : 'settings-warn'}>
                  {apiKey ? 'key set' : 'key required'}
                </span>
              </summary>
              <label className="ai-field" htmlFor="deepseek-key">
                <span>API key</span>
                <div className="ai-key-row">
                  <input
                    id="deepseek-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setError(null);
                    }}
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
                <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
                  Get a DeepSeek API key ↗
                </a>
                <span>
                  Key &amp; prompts go directly to api.deepseek.com. DeepSeek usage is billed to your
                  account. The key is only stored on this device if you tick “Remember”.
                </span>
              </div>
            </details>

            <div className="deepseek-mode ai-seg" role="group" aria-label="DeepSeek mode">
              <button
                type="button"
                className={mode === 'song' ? 'on' : ''}
                onClick={() => {
                  setMode('song');
                  setError(null);
                }}
              >
                Song → piano
              </button>
              <button
                type="button"
                className={mode === 'composer' ? 'on' : ''}
                onClick={() => {
                  setMode('composer');
                  setError(null);
                }}
              >
                Composer style
              </button>
            </div>

            {mode === 'song' ? (
              <>
                <label className="ai-prompt-label" htmlFor="deepseek-song">
                  Pop song name
                </label>
                <input
                  id="deepseek-song"
                  ref={songRef}
                  className="deepseek-input"
                  type="text"
                  value={songQuery}
                  placeholder="e.g. Shape of You — Ed Sheeran"
                  onChange={(event) => setSongQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void generate();
                  }}
                />
                <div className="deepseek-examples">
                  {SONG_EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className="ai-chip"
                      onClick={() => setSongQuery(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
                <p className="deepseek-hint">
                  DeepSeek writes a playable two-hand piano arrangement. If it does not know the
                  song, it creates an original piece in a similar pop style.
                </p>
              </>
            ) : (
              <>
                <label className="ai-prompt-label" htmlFor="deepseek-sheet-title">
                  Piano sheet name
                </label>
                <input
                  id="deepseek-sheet-title"
                  className="deepseek-input"
                  type="text"
                  value={sheetTitle}
                  placeholder="e.g. Nocturne in E-flat major"
                  onChange={(event) => setSheetTitle(event.target.value)}
                />
                <label className="ai-prompt-label" htmlFor="deepseek-composer">
                  Composer name
                </label>
                <input
                  id="deepseek-composer"
                  className="deepseek-input"
                  type="text"
                  value={composerName}
                  placeholder="e.g. Chopin"
                  onChange={(event) => setComposerName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void generate();
                  }}
                />
                <div className="deepseek-examples">
                  {COMPOSER_EXAMPLES.map((example) => (
                    <button
                      key={`${example.title}-${example.composer}`}
                      type="button"
                      className="ai-chip"
                      onClick={() => {
                        setSheetTitle(example.title);
                        setComposerName(example.composer);
                      }}
                    >
                      {example.title} · {example.composer}
                    </button>
                  ))}
                </div>
                <p className="deepseek-hint">
                  Writes an original piece in that composer’s style — harmony, texture and form —
                  not a copy of an existing work.
                </p>
              </>
            )}

            {error ? (
              <div className="ai-error" role="alert">
                {error}
              </div>
            ) : null}

            <button
              type="button"
              className="primary deepseek-generate"
              onClick={() => void generate()}
              disabled={busy}
            >
              {busy ? 'DeepSeek is composing…' : '✦ Generate with DeepSeek'}
            </button>
            <p className="deepseek-note">
              Song arrangements are generated by AI for personal practice; respect the original
              song’s copyright. DeepSeek usage is billed to your API account.
            </p>
          </div>

          <aside className={`ai-preview ${busy ? 'is-busy' : ''}`} aria-live="polite">
            {result ? (
              <>
                <p className="ai-eyebrow">Generated sheet</p>
                <h3>{result.meta.title}</h3>
                <p className="ai-description">{result.meta.description}</p>
                <div className="ai-meta">
                  <span>DeepSeek{result.meta.model ? ` · ${result.meta.model}` : ''}</span>
                  <span>{result.meta.keyName}</span>
                  <span>{result.meta.timeSignature}</span>
                  <span>{result.meta.bars} bars</span>
                  <span>{result.meta.bpm} BPM</span>
                  <span>{result.score.notes.length} notes</span>
                  <span>Both hands</span>
                </div>
                <div className="ai-preview-actions">
                  <button type="button" className="primary" onClick={() => onCreate(result)}>
                    Open in Studio
                  </button>
                  <button type="button" className="ghost" onClick={() => void generate()} disabled={busy}>
                    ↻ Regenerate
                  </button>
                </div>
                <p className="ai-hint">
                  Opens in the sheet view — press <strong>Listen</strong> to hear it, practice with
                  the keyboard, or export PDF/MusicXML/MIDI.
                </p>
              </>
            ) : (
              <div className="deepseek-empty">
                <p className="ai-eyebrow">Two ways to ask</p>
                <div className="deepseek-empty-card">
                  <strong>Song → piano</strong>
                  <span>Type a pop song and artist. DeepSeek arranges it for solo piano.</span>
                  <em>“Shape of You — Ed Sheeran”</em>
                </div>
                <div className="deepseek-empty-card">
                  <strong>Composer style</strong>
                  <span>Type a new sheet name and a composer. DeepSeek composes in their style.</span>
                  <em>“Nocturne in E-flat major · Chopin”</em>
                </div>
                <p className="ai-hint">
                  The result is a real two-hand score you can listen to, rename, practice and export.
                </p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
