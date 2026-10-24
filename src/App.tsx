import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePianoEngine } from './hooks/usePianoEngine';
import { usePlayback } from './hooks/usePlayback';
import { useQwertyInput } from './hooks/useQwertyInput';
import { useMidiInput } from './hooks/useMidiInput';
import { useRecorder, type RecordedNote } from './hooks/useRecorder';
import { Keyboard } from './components/Keyboard';
import { PianoRoll } from './components/PianoRoll';
import { Transport } from './components/Transport';
import { SongLibrary, type SongEntry, type SongKind } from './components/SongLibrary';
import { GamesPage, type GameKind } from './components/GamesPage';
import { SheetView } from './sheet/SheetView';
import { GameView } from './game/GameView';
import { QuizView } from './game/QuizView';
import { DEMO_SONGS } from './music/demo';
import {
  beatToSeconds,
  buildMeasures,
  measureBeats,
  scoreDurationSeconds,
} from './music/timing';
import { keySignatureName, midiToName } from './music/pitch';
import { recordingToScore } from './music/recording';
import { MAX_OCTAVE, MIN_OCTAVE } from './music/keymap';
import { parseScoreFile } from './music/formats/import';
import { buildExport, scoreFromJson, type ExportFormat } from './music/formats/export';
import type { Score } from './music/types';

type Tab = 'studio' | 'games';
type ViewMode = 'sheet' | 'roll';
type ToastKind = 'info' | 'success' | 'error';

interface ToastState {
  message: string;
  kind: ToastKind;
}

const STORAGE_KEY = 'piano-studio.library.v1';
const MAX_IMPORT_NOTES = 20000;

function loadLibrary(): SongEntry[] {
  const demos: SongEntry[] = DEMO_SONGS.map((score) => ({ score, kind: 'demo' }));
  if (typeof localStorage === 'undefined') return demos;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return demos;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return demos;
    const stored: SongEntry[] = [];
    for (const item of parsed.slice(0, 12)) {
      const candidate = item as { score?: Partial<Score>; kind?: SongKind } | null;
      const score = candidate?.score;
      if (!score || !Array.isArray(score.notes) || typeof score.title !== 'string') continue;
      const kind: SongKind = candidate?.kind === 'recording' ? 'recording' : 'imported';
      stored.push({
        kind,
        score: {
          id: typeof score.id === 'string' ? score.id : `stored-${stored.length}`,
          title: score.title,
          composer: typeof score.composer === 'string' ? score.composer : '',
          notes: score.notes,
          tempo: Array.isArray(score.tempo) && score.tempo.length ? score.tempo : [{ beat: 0, bpm: 120 }],
          timeSignatures:
            Array.isArray(score.timeSignatures) && score.timeSignatures.length
              ? score.timeSignatures
              : [{ beat: 0, numerator: 4, denominator: 4 }],
          keySignature: score.keySignature ?? { fifths: 0, mode: 'major' },
          ppq: typeof score.ppq === 'number' ? score.ppq : 480,
          source: kind === 'recording' ? 'recording' : 'midi',
          lengthBeats: typeof score.lengthBeats === 'number' ? score.lengthBeats : 0,
        },
      });
    }
    return [...demos, ...stored];
  } catch {
    return demos;
  }
}

function persistLibrary(songs: SongEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const custom = songs.filter((entry) => entry.kind !== 'demo').slice(-12);
    const payload = custom.map((entry) => ({ kind: entry.kind, score: entry.score }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage may be full or unavailable */
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'piano-sheet';
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function App() {
  const { engine, ready, enableAudio, volume, setVolume } = usePianoEngine();

  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef(0);
  const showToast = useCallback((message: string, kind: ToastKind = 'info') => {
    setToast({ message, kind });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4600);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const [songs, setSongs] = useState<SongEntry[]>(loadLibrary);
  const [currentId, setCurrentId] = useState<string>(() => DEMO_SONGS[0]?.id ?? '');
  const score = useMemo<Score>(() => {
    const found = songs.find((entry) => entry.score.id === currentId);
    return found?.score ?? songs[0]?.score ?? DEMO_SONGS[0];
  }, [songs, currentId]);

  const [tab, setTab] = useState<Tab>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'games' ? 'games' : 'studio',
  );
  const [activeGame, setActiveGame] = useState<GameKind | null>(() => {
    const game = new URLSearchParams(window.location.search).get('game');
    return game === 'falling' || game === 'quiz' ? game : null;
  });
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    new URLSearchParams(window.location.search).get('view') === 'roll' ? 'roll' : 'sheet',
  );
  const [tempoScale, setTempoScale] = useState(1);
  const [loop, setLoop] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [octave, setOctave] = useState(4);
  const [showLabels, setShowLabels] = useState(true);
  const [sustain, setSustain] = useState(false);
  const [liveNotes, setLiveNotes] = useState<ReadonlySet<number>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);

  const playback = usePlayback({ score, engine, tempoScale, loop, metronome });

  const handleRecordingFinish = useCallback(
    (notes: RecordedNote[], durationMs: number) => {
      if (!notes.length) {
        showToast('Nothing was recorded — press some piano keys while recording.', 'error');
        return;
      }
      const recorded = recordingToScore(
        notes,
        `Recording ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      );
      if (!recorded.notes.length) {
        showToast('The recording was too short to turn into sheet music.', 'error');
        return;
      }
      const entry: SongEntry = { score: recorded, kind: 'recording' };
      setSongs((prev) => [...prev, entry]);
      setCurrentId(recorded.id);
      showToast(
        `Recorded ${recorded.notes.length} notes (${Math.round(durationMs / 1000)}s). Export it as MusicXML!`,
        'success',
      );
    },
    [showToast],
  );
  const recorder = useRecorder(handleRecordingFinish);

  const recorderNoteOn = recorder.noteOn;
  const recorderNoteOff = recorder.noteOff;

  const handleNoteOn = useCallback(
    (midi: number, velocity: number) => {
      engine.noteOn(midi, velocity);
      recorderNoteOn(midi, velocity);
      setLiveNotes((prev) => {
        if (prev.has(midi)) return prev;
        const next = new Set(prev);
        next.add(midi);
        return next;
      });
    },
    [engine, recorderNoteOn],
  );

  const handleNoteOff = useCallback(
    (midi: number) => {
      engine.noteOff(midi);
      recorderNoteOff(midi);
      setLiveNotes((prev) => {
        if (!prev.has(midi)) return prev;
        const next = new Set(prev);
        next.delete(midi);
        return next;
      });
    },
    [engine, recorderNoteOff],
  );

  const togglePlay = useCallback(() => {
    if (playback.isPlaying) playback.pause();
    else void playback.play();
  }, [playback]);

  useQwertyInput({
    enabled: tab === 'studio',
    octave,
    onNoteOn: handleNoteOn,
    onNoteOff: handleNoteOff,
    onTogglePlay: togglePlay,
    onOctaveChange: (direction) =>
      setOctave((value) => Math.min(MAX_OCTAVE, Math.max(MIN_OCTAVE, value + direction))),
  });

  const midi = useMidiInput({ onNoteOn: handleNoteOn, onNoteOff: handleNoteOff });

  useEffect(() => {
    engine.sustain(sustain);
  }, [engine, sustain]);

  useEffect(() => {
    persistLibrary(songs);
  }, [songs]);

  const activeMidis = useMemo(() => {
    const set = new Set<number>(playback.soundingMidis);
    for (const midiNote of liveNotes) set.add(midiNote);
    return Array.from(set).sort((a, b) => a - b);
  }, [playback.soundingMidis, liveNotes]);

  const pressedMidis = useMemo(() => Array.from(liveNotes), [liveNotes]);
  const activeNames = useMemo(() => activeMidis.slice(0, 10).map(midiToName), [activeMidis]);

  const measures = useMemo(() => buildMeasures(score), [score]);
  const durationSeconds = useMemo(() => scoreDurationSeconds(score), [score]);
  const currentSeconds = beatToSeconds(score, playback.currentBeat);

  const barLabel = useMemo(() => {
    if (!measures.length) return 'Bar 1';
    const beat = Math.min(playback.currentBeat, Math.max(0, score.lengthBeats));
    const measure =
      measures.find((candidate) => beat >= candidate.start - 1e-9 && beat < candidate.end) ??
      measures[measures.length - 1];
    const beatsPerBar = measureBeats(measure.timeSignature);
    const beatInBar = Math.min(Math.floor(beat - measure.start) + 1, Math.ceil(beatsPerBar));
    return `Bar ${measure.index + 1}.${Math.max(1, beatInBar)}`;
  }, [measures, playback.currentBeat, score.lengthBeats]);

  const handCount = useMemo(() => new Set(score.notes.map((note) => note.hand)).size, [score]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setImporting(true);
      try {
        if (file.size > 8 * 1024 * 1024) throw new Error('File is too large (8 MB maximum).');
        const buffer = await file.arrayBuffer();
        const imported: Score = /\.json$/i.test(file.name)
          ? scoreFromJson(new TextDecoder().decode(buffer))
          : await parseScoreFile(file.name, buffer);
        if (!imported.notes.length) throw new Error('No playable notes were found in this file.');
        if (imported.notes.length > MAX_IMPORT_NOTES) {
          throw new Error(`This score has too many notes (limit ${MAX_IMPORT_NOTES.toLocaleString()}).`);
        }
        const entry: SongEntry = {
          kind: 'imported',
          score: {
            ...imported,
            id: `import-${Date.now().toString(36)}`,
            title: imported.title || file.name.replace(/\.[^.]+$/, ''),
          },
        };
        setSongs((prev) => [...prev, entry]);
        setCurrentId(entry.score.id);
        setTab('studio');
        setActiveGame(null);
        showToast(`Imported “${entry.score.title}” — ${entry.score.notes.length} notes.`, 'success');
      } catch (error) {
        showToast(
          `Import failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [showToast],
  );

  const handleExport = useCallback(
    async (format: ExportFormat | 'svg') => {
      try {
        if (format === 'svg') {
          const sheetModule = (await import('./sheet/SheetView')) as unknown as {
            renderScoreSvg?: (value: Score) => string;
          };
          if (typeof sheetModule.renderScoreSvg !== 'function') {
            throw new Error('SVG notation export is not available yet.');
          }
          const svg = sheetModule.renderScoreSvg(score);
          downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${slugify(score.title)}.svg`);
        } else {
          const { fileName, mime, data } = buildExport(score, format);
          const payload =
            typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
          downloadBlob(new Blob([payload], { type: mime }), fileName);
        }
        showToast(`Exported ${format === 'svg' ? 'SVG sheet' : format.toUpperCase()}.`, 'success');
      } catch (error) {
        showToast(
          `Export failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
    [score, showToast],
  );

  const handleToggleRecord = useCallback(() => {
    if (recorder.recording) {
      recorder.stop();
      return;
    }
    playback.pause();
    void recorder.start(engine);
    showToast('Recording — play the piano, then press Record again to stop.', 'info');
  }, [engine, playback, recorder, showToast]);

  const handleRemoveSong = useCallback(
    (id: string) => {
      const remaining = songs.filter((entry) => entry.score.id !== id);
      setSongs(remaining);
      if (currentId === id) setCurrentId(remaining[0]?.score.id ?? DEMO_SONGS[0].id);
    },
    [songs, currentId],
  );

  const selectTab = useCallback(
    (next: Tab) => {
      if (next === tab) return;
      playback.pause();
      if (recorder.recording) recorder.stop();
      if (next === 'games') setActiveGame(null);
      else engine.stopAll();
      setTab(next);
    },
    [tab, playback, recorder, engine],
  );

  const startGame = useCallback(
    (kind: GameKind) => {
      playback.pause();
      if (recorder.recording) recorder.stop();
      setActiveGame(kind);
    },
    [playback, recorder],
  );

  const exitGame = useCallback(() => {
    engine.stopAll();
    setActiveGame(null);
  }, [engine]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const midiLabel = !midi.supported
    ? 'MIDI n/a'
    : midi.status === 'denied'
      ? 'MIDI blocked'
      : midi.devices.length
        ? `MIDI: ${midi.devices[0]}`
        : midi.status === 'ready'
          ? 'MIDI: no device'
          : 'Connect MIDI';

  const inGame = tab === 'games' && activeGame !== null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ♪
          </span>
          <div className="brand-text">
            <h1>Piano Studio</h1>
            <p>Play · Read · Practice</p>
          </div>
        </div>

        <nav className="tabs" aria-label="Sections">
          <button
            type="button"
            className={`tab ${tab === 'studio' ? 'active' : ''}`}
            onClick={() => selectTab('studio')}
          >
            Studio
          </button>
          <button
            type="button"
            className={`tab ${tab === 'games' ? 'active' : ''}`}
            onClick={() => selectTab('games')}
          >
            Games
          </button>
        </nav>

        <div className="header-right">
          <button
            type="button"
            className={`audio-pill ${ready ? 'ready' : ''}`}
            onClick={() => {
              void enableAudio();
              if (!ready) showToast('Audio enabled — you should hear the piano now.', 'success');
            }}
            title="Browsers need one click before audio can play"
          >
            <span className={`status-dot ${ready ? 'on' : ''}`} />
            {ready ? 'Sound on' : 'Enable sound'}
          </button>
          <label className="volume-control" title="Master volume">
            <span aria-hidden="true">🔊</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
              aria-label="Master volume"
            />
          </label>
          <button
            type="button"
            className="midi-pill"
            onClick={() => {
              midi.connect();
              showToast('Requesting MIDI access from the browser…', 'info');
            }}
            title="Connect a USB/MIDI keyboard"
          >
            {midiLabel}
          </button>
        </div>
      </header>

      <main
        className={`app-main ${inGame ? 'game-mode' : ''} ${dragging ? 'dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {tab === 'studio' && (
          <div className="studio">
            <aside className="sidebar">
              <SongLibrary
                songs={songs}
                currentId={score.id}
                importing={importing}
                onSelect={setCurrentId}
                onImport={handleImportClick}
                onRemove={handleRemoveSong}
              />
            </aside>

            <section className="stage">
              <div className="stage-head">
                <div className="score-heading">
                  <h2>{score.title}</h2>
                  <div className="score-tags">
                    <span>{score.composer || 'Unknown composer'}</span>
                    <span>{keySignatureName(score.keySignature.fifths, score.keySignature.mode)}</span>
                    <span>
                      {score.timeSignatures[0]?.numerator ?? 4}/{score.timeSignatures[0]?.denominator ?? 4}
                    </span>
                    <span>{Math.round(score.tempo[0]?.bpm ?? 120)} BPM</span>
                    <span>{score.notes.length} notes</span>
                    <span>{handCount === 2 ? 'Both hands' : handCount === 1 ? 'One hand' : 'No hands'}</span>
                  </div>
                </div>
                <div className="stage-actions">
                  <div className="segmented" role="group" aria-label="Score view">
                    <button
                      type="button"
                      className={viewMode === 'sheet' ? 'active' : ''}
                      onClick={() => setViewMode('sheet')}
                    >
                      Sheet
                    </button>
                    <button
                      type="button"
                      className={viewMode === 'roll' ? 'active' : ''}
                      onClick={() => setViewMode('roll')}
                    >
                      Piano roll
                    </button>
                  </div>
                  <div className="export-group">
                    <span className="export-label">Export</span>
                    <button type="button" onClick={() => void handleExport('musicxml')}>
                      MusicXML
                    </button>
                    <button type="button" onClick={() => void handleExport('midi')}>
                      MIDI
                    </button>
                    <button type="button" onClick={() => void handleExport('json')}>
                      JSON
                    </button>
                    <button type="button" onClick={() => void handleExport('svg')}>
                      SVG
                    </button>
                  </div>
                </div>
              </div>

              <div className="stage-view">
                {viewMode === 'sheet' ? (
                  <SheetView
                    score={score}
                    currentBeat={playback.currentBeat}
                    activeMidis={activeMidis}
                    follow={playback.isPlaying}
                    onSeek={playback.seek}
                    className="sheet-view"
                  />
                ) : (
                  <PianoRoll
                    score={score}
                    getPosition={playback.getPosition}
                    isPlaying={playback.isPlaying}
                    onSeek={playback.seek}
                  />
                )}
              </div>

              <Transport
                isPlaying={playback.isPlaying}
                currentBeat={playback.currentBeat}
                lengthBeats={Math.max(score.lengthBeats, 0.01)}
                currentSeconds={currentSeconds}
                durationSeconds={durationSeconds}
                barLabel={barLabel}
                tempoScale={tempoScale}
                loop={loop}
                metronome={metronome}
                recording={recorder.recording}
                recordElapsedMs={recorder.elapsedMs}
                disabled={!score.notes.length}
                onPlayPause={togglePlay}
                onStop={playback.stop}
                onSeek={playback.seek}
                onTempoScale={setTempoScale}
                onToggleLoop={() => setLoop((value) => !value)}
                onToggleMetronome={() => setMetronome((value) => !value)}
                onToggleRecord={handleToggleRecord}
              />

              <div className="keyboard-dock">
                <div className="keyboard-bar">
                  <div className="now-playing">
                    <span className="now-label">Now playing</span>
                    <span className={`now-notes ${activeMidis.length ? 'active' : ''}`}>
                      {activeMidis.length === 0
                        ? 'Click a key or press A–K'
                        : `${activeNames.join(' · ')}${activeMidis.length > 10 ? ` +${activeMidis.length - 10}` : ''}`}
                    </span>
                  </div>
                  <div className="keyboard-controls">
                    <div className="octave-control">
                      <button
                        type="button"
                        onClick={() => setOctave((value) => Math.max(MIN_OCTAVE, value - 1))}
                        aria-label="Octave down"
                        title="Octave down (Z)"
                      >
                        −
                      </button>
                      <span>Oct {octave}</span>
                      <button
                        type="button"
                        onClick={() => setOctave((value) => Math.min(MAX_OCTAVE, value + 1))}
                        aria-label="Octave up"
                        title="Octave up (X)"
                      >
                        +
                      </button>
                    </div>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={showLabels}
                        onChange={(event) => setShowLabels(event.target.checked)}
                      />
                      Labels
                    </label>
                    <button
                      type="button"
                      className={`toggle ${sustain ? 'on' : ''}`}
                      onClick={() => setSustain((value) => !value)}
                      aria-pressed={sustain}
                      title="Hold the damper pedal"
                    >
                      Pedal
                    </button>
                  </div>
                </div>
                <Keyboard
                  activeMidis={activeMidis}
                  pressedMidis={pressedMidis}
                  qwertyOctave={octave}
                  showLabels={showLabels}
                  onNoteOn={handleNoteOn}
                  onNoteOff={handleNoteOff}
                />
              </div>

              {recorder.recording && (
                <div className="recording-banner" role="status">
                  <span className="record-dot" /> Recording {formatClock(recorder.elapsedMs / 1000)} —
                  press Record to stop and turn it into sheet music
                </div>
              )}
            </section>
          </div>
        )}

        {tab === 'games' && !activeGame && <GamesPage score={score} onStart={startGame} />}
        {tab === 'games' && activeGame === 'falling' && (
          <GameView score={score} engine={engine} onExit={exitGame} />
        )}
        {tab === 'games' && activeGame === 'quiz' && (
          <QuizView engine={engine} onExit={exitGame} />
        )}
      </main>

      <input
        ref={fileInputRef}
        type="file"
        accept=".mid,.midi,.musicxml,.xml,.mxl,.json"
        className="visually-hidden"
        aria-label="Import a piano sheet"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}
