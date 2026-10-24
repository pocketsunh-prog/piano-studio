import { useEffect, useRef, useState } from 'react';
import type { Score } from '../music/types';
import {
  externalSheetLinks,
  importOnlineMidi,
  searchOnlineSheets,
  type OnlineSheetResult,
  type OnlineSheetSearchResult,
} from '../music/online/commons';

export interface OnlineSheetsProps {
  initialQuery: string;
  onClose: () => void;
  onImport: (score: Score, result: OnlineSheetResult) => void;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const EMPTY_RESULTS: OnlineSheetSearchResult = { midi: [], sheets: [] };

export function OnlineSheets({ initialQuery, onClose, onImport }: OnlineSheetsProps) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<OnlineSheetSearchResult>(EMPTY_RESULTS);
  const [searching, setSearching] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const autoSearchedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const runSearch = async (rawQuery?: string) => {
    const term = (rawQuery ?? query).trim();
    if (!term) {
      setError('Enter a song name, composer or style.');
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setSearching(true);
    setError(null);
    try {
      const found = await searchOnlineSheets(term, {
        limit: 10,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setResults(found);
        setSearched(true);
      }
    } catch (searchError) {
      if (!controller.signal.aborted) {
        setError(
          searchError instanceof Error
            ? searchError.message
            : 'Online sheet search failed. Check your connection.',
        );
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setSearching(false);
      }
    }
  };

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      requestRef.current?.abort();
    };
  }, [onClose]);

  useEffect(() => {
    if (autoSearchedRef.current) return;
    autoSearchedRef.current = true;
    if (initialQuery.trim()) void runSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleImport = async (result: OnlineSheetResult) => {
    if (importingId) return;
    setImportingId(result.id);
    setError(null);
    try {
      const score = await importOnlineMidi(result);
      onImport(score, result);
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : 'Could not import this MIDI file.',
      );
    } finally {
      setImportingId(null);
    }
  };

  const links = externalSheetLinks(query);
  const noResults = searched && !searching && !results.midi.length && !results.sheets.length;

  const renderMidi = (result: OnlineSheetResult) => (
    <li key={result.id} className="online-row">
      <div className="online-icon" aria-hidden="true">
        🎵
      </div>
      <div className="online-main">
        <strong title={result.title}>{result.title}</strong>
        <span className="online-meta">
          MIDI
          {result.artist ? ` · ${result.artist}` : ''}
          {result.license ? ` · ${result.license}` : ''}
          {result.sizeBytes ? ` · ${formatSize(result.sizeBytes)}` : ''}
        </span>
      </div>
      <div className="online-actions">
        <button
          type="button"
          className="primary"
          onClick={() => void handleImport(result)}
          disabled={importingId !== null}
        >
          {importingId === result.id ? 'Importing…' : 'Import & play'}
        </button>
        <a href={result.descriptionUrl} target="_blank" rel="noreferrer">
          Page ↗
        </a>
      </div>
    </li>
  );

  const renderSheet = (result: OnlineSheetResult) => (
    <li key={result.id} className="online-row sheet">
      {result.thumbnailUrl ? (
        <img className="online-thumb" src={result.thumbnailUrl} alt="" loading="lazy" />
      ) : (
        <div className="online-icon" aria-hidden="true">
          📄
        </div>
      )}
      <div className="online-main">
        <strong title={result.title}>{result.title}</strong>
        <span className="online-meta">
          PDF
          {result.license ? ` · ${result.license}` : ''}
          {result.sizeBytes ? ` · ${formatSize(result.sizeBytes)}` : ''}
        </span>
      </div>
      <div className="online-actions">
        <a className="online-open" href={result.fileUrl} target="_blank" rel="noreferrer">
          Open PDF ↗
        </a>
        <a href={result.descriptionUrl} target="_blank" rel="noreferrer">
          Page ↗
        </a>
      </div>
    </li>
  );

  return (
    <div
      className="ai-overlay online-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="ai-dialog online-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="online-title"
      >
        <header className="ai-header">
          <div>
            <p className="ai-eyebrow">Wikimedia Commons · public domain / CC</p>
            <h2 id="online-title">Online sheet search</h2>
            <p className="ai-subtitle">
              Search by song name or composer. Import playable MIDI files directly, or open public
              PDF sheet scans.
            </p>
          </div>
          <button type="button" className="ai-close" onClick={onClose} aria-label="Close online search">
            ×
          </button>
        </header>

        <div className="online-body">
          <form
            className="online-search"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Song name or composer, e.g. Clair de Lune"
              aria-label="Search online sheets"
            />
            <button type="submit" className="primary" disabled={searching}>
              {searching ? 'Searching…' : '⌕ Search'}
            </button>
          </form>

          <div className="online-external">
            <span>Also search:</span>
            {links.map((link) => (
              <a key={link.label} href={link.url} target="_blank" rel="noreferrer">
                {link.label} ↗
              </a>
            ))}
          </div>

          {error ? (
            <div className="ai-error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="online-results">
            {searching ? (
              <div className="online-loading">
                <span className="online-spinner" aria-hidden="true" />
                Searching Wikimedia Commons…
              </div>
            ) : noResults ? (
              <div className="online-empty">
                <p>No Commons results for “{query}”.</p>
                <span>Try a simpler title, the composer’s surname, or use the external searches above.</span>
              </div>
            ) : (
              <>
                <section className="online-group">
                  <h3>
                    Playable MIDI <span>{results.midi.length}</span>
                  </h3>
                  {results.midi.length ? (
                    <ul>{results.midi.map(renderMidi)}</ul>
                  ) : (
                    <p className="online-none">No MIDI performance found.</p>
                  )}
                </section>

                <section className="online-group">
                  <h3>
                    PDF sheet scans <span>{results.sheets.length}</span>
                  </h3>
                  {results.sheets.length ? (
                    <ul>{results.sheets.map(renderSheet)}</ul>
                  ) : (
                    <p className="online-none">No PDF scans found.</p>
                  )}
                </section>
              </>
            )}
          </div>

          <p className="online-note">
            MIDI files and scans come from Wikimedia Commons and keep their original licences.
            Imports are stored only in this browser. Use MuseScore/IMSLP links for more editions.
          </p>
        </div>
      </div>
    </div>
  );
}
