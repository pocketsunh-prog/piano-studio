import { useEffect, useRef, useState } from 'react';
import {
  composerStyleGuide,
  type DeepSeekConfig,
  type DeepSeekReference,
} from '../music/ai/deepseek';
import { CLOUD_PROVIDERS } from '../music/ai/cloudProviders';
import {
  loadCloudSettings,
  saveCloudSettings,
  type CloudProviderId,
} from '../music/ai/deepseekSettings';
import type { AiComposition } from '../music/ai/composer';

export interface CloudComposerProps {
  onClose: () => void;
  onCreate: (composition: AiComposition) => void;
  /** Which cloud provider this dialog talks to. */
  provider?: CloudProviderId;
}

type CloudMode = 'song' | 'composer';

const SONG_EXAMPLES = ['Shape of You — Ed Sheeran', 'Clair de Lune', 'Yesterday — The Beatles'];
const COMPOSER_EXAMPLES: Array<{ title: string; composer: string }> = [
  { title: 'Nocturne in E-flat major', composer: 'Chopin' },
  { title: 'Prelude in C major', composer: 'Bach' },
  { title: 'Waltz for a Rainy Day', composer: 'Debussy' },
];

export function CloudComposer({
  onClose,
  onCreate,
  provider = 'deepseek',
}: CloudComposerProps) {
  const providerConfig = CLOUD_PROVIDERS[provider];
  const providerLabel = providerConfig.label;
  const [stored] = useState(() => loadCloudSettings(provider));
  const [mode, setMode] = useState<CloudMode>('song');
  const [songQuery, setSongQuery] = useState('');
  const [sheetTitle, setSheetTitle] = useState('');
  const [composerName, setComposerName] = useState('');
  const [apiKey, setApiKey] = useState(stored.apiKey ?? '');
  const [model, setModel] = useState(() => {
    if (provider === 'deepseek' && !stored.modelMigrated) {
      return providerConfig.defaultModel;
    }
    return stored.model ?? providerConfig.defaultModel;
  });
  const [baseUrl, setBaseUrl] = useState(stored.baseUrl ?? providerConfig.defaultBaseUrl);
  const [rememberKey, setRememberKey] = useState(Boolean(stored.remember));
  const [showKey, setShowKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(!stored.apiKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiComposition | null>(null);
  const [useReference, setUseReference] = useState(providerConfig.supportsSearch);
  const [manualReference, setManualReference] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [referenceNote, setReferenceNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const songRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    saveCloudSettings(provider, {
      apiKey,
      model,
      baseUrl,
      remember: rememberKey,
      modelMigrated: true,
    });
  }, [provider, apiKey, model, baseUrl, rememberKey]);

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
      setError(`Enter your ${providerLabel} API key first.`);
      setSettingsOpen(true);
      return;
    }

    const prompt =
      mode === 'song'
        ? `Arrange the song "${song}" as a solo piano piece. Make the signature vocal hook recognizable within the first two bars, follow the song's key and chord progression, and structure the arrangement as a 4-bar intro + 8-bar hook/chorus + 4-bar ending. Put the melody in the right hand and accompaniment in the left.`
        : `Compose an original solo piano piece titled "${title}" in the style of ${composer}. Apply the style guide concretely — harmony, texture, phrase shape and form — and do not copy an existing composition.`;
    const config: DeepSeekConfig = { apiKey, model, baseUrl };
    const options =
      mode === 'song'
        ? {
            style: 'pop' as const,
            mood: 'happy' as const,
            difficulty: 'medium' as const,
            fallbackTitle: `${song} (Piano Arrangement)`,
            descriptionHint: `Piano arrangement of “${song}”`,
            bars: 16,
          }
        : {
            style: 'classical' as const,
            mood: 'dreamy' as const,
            difficulty: 'medium' as const,
            fallbackTitle: title,
            descriptionHint: `Original piece in the style of ${composer}`,
            bars: 16,
          };

    setBusy(true);
    setError(null);
    setReferenceNote(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const styleGuide = mode === 'composer' ? composerStyleGuide(composer) : undefined;
    const manual = mode === 'song' ? manualReference.trim().slice(0, 2000) : '';
    let referenceText = manual ? `USER-PROVIDED MELODY/CHORDS:\n${manual}` : '';
    try {
      if (useReference && providerConfig.supportsSearch) {
        try {
          setStatus(
            mode === 'song'
              ? 'Looking up song references…'
              : styleGuide
                ? 'Preparing composer style…'
                : 'Looking up composer style…',
          );
          let references: DeepSeekReference[] = [];
          if (mode === 'song') {
            references = await providerConfig.search(
              `${song} piano chords key tempo melody notes`,
              config,
              controller.signal,
            );
          } else if (!styleGuide) {
            references = await providerConfig.search(
              `${composer} piano composition style harmony texture form`,
              config,
              controller.signal,
            );
          }
          if (controller.signal.aborted) return;
          if (references.length) {
            const webReferences = references
              .map((reference, index) => `${index + 1}. ${reference.title}: ${reference.summary}`)
              .join('\n');
            referenceText = [referenceText, `WEB LOOKUP:\n${webReferences}`]
              .filter(Boolean)
              .join('\n\n');
            setReferenceNote(
              `Used ${references.length} web reference${references.length === 1 ? '' : 's'}${
                manual ? ' + your pasted reference' : ''
              }.`,
            );
          } else if (mode === 'song') {
            setReferenceNote(
              manual
                ? 'Using your pasted melody/chords (no extra web reference found).'
                : 'No web reference found; composing from model knowledge.',
            );
          } else if (!styleGuide) {
            setReferenceNote('No style reference found; composing from model knowledge.');
          } else {
            setReferenceNote(`Using the built-in ${composer} style guide.`);
          }
        } catch {
          if (controller.signal.aborted) return;
          setReferenceNote('Reference lookup unavailable; composing from model knowledge.');
        }
      } else if (manual) {
        setReferenceNote('Using your pasted melody/chords.');
      } else if (styleGuide) {
        setReferenceNote(`Using the built-in ${composer} style guide.`);
      }

      setStatus(`${providerLabel} is composing…`);
      const composition = await providerConfig.compose(
        prompt,
        config,
        { ...options, referenceText, styleGuide },
        controller.signal,
      );
      if (!controller.signal.aborted) setResult(composition);
    } catch (generationError) {
      if (!controller.signal.aborted) {
        setError(
          generationError instanceof Error
            ? generationError.message
            : `${providerLabel} generation failed.`,
        );
      }
    } finally {
      setStatus(null);
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
        className={`ai-dialog deepseek-dialog cloud-dialog cloud-${provider}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${provider}-title`}
      >
        <header className="ai-header">
          <div>
            <p className="ai-eyebrow">{providerConfig.eyebrow}</p>
            <h2 id={`${provider}-title`}>{providerConfig.title}</h2>
            <p className="ai-subtitle">{providerConfig.subtitle}</p>
          </div>
          <button
            type="button"
            className="ai-close"
            onClick={onClose}
            aria-label={`Close ${providerLabel} composer`}
          >
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
                {providerLabel} API settings
                <span className={apiKey ? 'settings-ok' : 'settings-warn'}>
                  {apiKey ? 'key set' : 'key required'}
                </span>
              </summary>
              <label className="ai-field" htmlFor={`${provider}-key`}>
                <span>API key</span>
                <div className="ai-key-row">
                  <input
                    id={`${provider}-key`}
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
                    {providerConfig.models.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                  <small
                    className={`deepseek-model-note ${
                      provider === 'deepseek' && model === 'deepseek-flash' ? 'warn' : ''
                    }`}
                  >
                    {provider === 'deepseek' && model === 'deepseek-flash'
                      ? 'Flash is faster but may produce more generic arrangements; V4 Pro is recommended.'
                      : providerConfig.modelHint}
                  </small>
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
                    placeholder={providerConfig.defaultBaseUrl}
                    spellCheck={false}
                  />
                </label>
              </details>
              <div className="ai-deepseek-links">
                <a href={providerConfig.keyLink} target="_blank" rel="noreferrer">
                  Get a {providerLabel} API key ↗
                </a>
                <span>
                  Key &amp; prompts go directly to {providerConfig.keyHost}. {providerLabel} usage is
                  billed to your account. The key is only stored on this device if you tick “Remember”.
                </span>
              </div>
            </details>

            <div className="deepseek-mode ai-seg" role="group" aria-label={`${providerLabel} mode`}>
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

            {providerConfig.supportsSearch ? (
              <label className="deepseek-check">
                <input
                  type="checkbox"
                  checked={useReference}
                  onChange={(event) => setUseReference(event.target.checked)}
                />
                <span>
                  Look up song/style details online
                  <em>{providerConfig.searchName} · one extra request</em>
                </span>
              </label>
            ) : (
              <p className="deepseek-reference-unavailable">
                Kimi Search isn’t available from the browser. Use the optional melody/chords box
                below for a closer arrangement.
              </p>
            )}

            {mode === 'song' ? (
              <>
                <label className="ai-prompt-label" htmlFor={`${provider}-song`}>
                  Pop song name
                </label>
                <input
                  id={`${provider}-song`}
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
                  {providerConfig.supportsSearch
                    ? `${providerLabel} looks up key/chords/hook references online, then writes a playable two-hand arrangement. If the song still sounds too generic, paste the melody or chords below.`
                    : `${providerLabel} arranges from model knowledge. For a closer match, paste the main melody notes or chord progression below.`}
                </p>
                <details className="deepseek-manual-ref">
                  <summary>Optional: paste melody notes or chords</summary>
                  <textarea
                    value={manualReference}
                    onChange={(event) => setManualReference(event.target.value)}
                    rows={3}
                    maxLength={2000}
                    placeholder="e.g. G#4 G#4 F#4 E4 … or C#m | F#m | A | B"
                  />
                  <span>
                    Melody as note names, or chord symbols per bar. This is passed to {providerLabel}{' '}
                    as the reference to follow.
                  </span>
                </details>
              </>
            ) : (
              <>
                <label className="ai-prompt-label" htmlFor={`${provider}-sheet-title`}>
                  Piano sheet name
                </label>
                <input
                  id={`${provider}-sheet-title`}
                  className="deepseek-input"
                  type="text"
                  value={sheetTitle}
                  placeholder="e.g. Nocturne in E-flat major"
                  onChange={(event) => setSheetTitle(event.target.value)}
                />
                <label className="ai-prompt-label" htmlFor={`${provider}-composer`}>
                  Composer name
                </label>
                <input
                  id={`${provider}-composer`}
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

            {referenceNote ? (
              <p className="deepseek-reference-note">{referenceNote}</p>
            ) : null}

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
              {busy
                ? (status ?? `${providerLabel} is composing…`)
                : `✦ Generate with ${providerLabel}`}
            </button>
            <p className="deepseek-note">
              {providerLabel} arrangements are AI approximations.{' '}
              {providerConfig.supportsSearch
                ? 'Web lookup improves key/chord/style matching, but for exact notes import a MIDI.'
                : 'Paste the melody/chords for a closer match; for exact notes import a MIDI.'}{' '}
              Song arrangements are for personal practice; respect the original song’s copyright.{' '}
              {providerLabel} usage{providerConfig.supportsSearch ? ' and Search requests' : ''} are
              billed to your API account.
            </p>
          </div>

          <aside className={`ai-preview ${busy ? 'is-busy' : ''}`} aria-live="polite">
            {result ? (
              <>
                <p className="ai-eyebrow">Generated sheet</p>
                <h3>{result.meta.title}</h3>
                <p className="ai-description">{result.meta.description}</p>
                <div className="ai-meta">
                  <span>
                    {providerLabel}
                    {result.meta.model ? ` · ${result.meta.model}` : ''}
                  </span>
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
                  <span>Type a pop song and artist. {providerLabel} arranges it for solo piano.</span>
                  <em>“Shape of You — Ed Sheeran”</em>
                </div>
                <div className="deepseek-empty-card">
                  <strong>Composer style</strong>
                  <span>
                    Type a new sheet name and a composer. {providerLabel} composes in their style.
                  </span>
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
