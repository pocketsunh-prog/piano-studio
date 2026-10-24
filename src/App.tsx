import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { AiComposer } from './components/AiComposer';
import { DeepSeekComposer } from './components/DeepSeekComposer';
import { OnlineSheets } from './components/OnlineSheets';
import { SoundMeter } from './components/SoundMeter';
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
import type { AiComposition } from './music/ai/composer';
import type { OnlineSheetResult } from './music/online/commons';
import { saveBlob } from './platform/saveBlob';
import {
  isNativeApp,
  setupNativeShell,
  useAndroidBackButton,
  useNativePause,
  useWakeLock,
} from './platform/native';

type Tab = 'studio' | 'games';
type ViewMode = 'sheet' | 'roll';
type ToastKind = 'info' | 'success' | 'error';

// VexFlow (notation) and the game views are large; load them on demand so the
// piano shell appears quickly, especially in the Android WebView.
const SheetView = lazy(() =>
  import('./sheet/SheetView').then((module) => ({ default: module.SheetView })),
);
const GameView = lazy(() =>
  import('./game/GameView').then((module) => ({ default: module.GameView })),
);
const QuizView = lazy(() =>
  import('./game/QuizView').then((module) => ({ default: module.QuizView })),
);

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
      const kind: SongKind =
        candidate?.kind === 'recording'
          ? 'recording'
          : candidate?.kind === 'ai'
            ? 'ai'
            : candidate?.kind === 'deepseek'
              ? 'deepseek'
              : candidate?.kind === 'online'
                ? 'online'
                : 'imported';
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
  const [aiOpen, setAiOpen] = useState(false);
  const [deepseekOpen, setDeepseekOpen] = useState(false);
  const [onlineOpen, setOnlineOpen] = useState(false);

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
    enabled: tab === 'studio' && !aiOpen && !deepseekOpen && !onlineOpen,
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
    async (format: ExportFormat | 'svg' | 'pdf') => {
      try {
        let blob: Blob;
        let fileName: string;
        let label: string;
        if (format === 'svg') {
          const sheetModule = (await import('./sheet/SheetView')) as unknown as {
            renderScoreSvg?: (value: Score) => string;
          };
          if (typeof sheetModule.renderScoreSvg !== 'function') {
            throw new Error('SVG notation export is not available yet.');
          }
          const svg = sheetModule.renderScoreSvg(score);
          blob = new Blob([svg], { type: 'image/svg+xml' });
          fileName = `${slugify(score.title)}.svg`;
          label = 'SVG sheet';
        } else if (format === 'pdf') {
          showToast('Preparing PDF sheet…', 'info');
          const { createScorePdf } = await import('./export/pdf');
          const pdf = await createScorePdf(score);
          blob = pdf.blob;
          fileName = `${slugify(score.title)}.pdf`;
          label = `PDF sheet (${pdf.pages} page${pdf.pages === 1 ? '' : 's'})`;
        } else {
          const exported = buildExport(score, format);
          const payload =
            typeof exported.data === 'string'
              ? new TextEncoder().encode(exported.data)
              : new Uint8Array(exported.data);
          blob = new Blob([payload], { type: exported.mime });
          fileName = exported.fileName;
          label = format.toUpperCase();
        }
        const saved = await saveBlob(blob, fileName);
        showToast(
          saved.mode === 'shared'
            ? `${saved.fileName} is ready — choose an app to save or share it.`
            : `Exported ${label}.`,
          'success',
        );
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

  const handleRenameSong = useCallback(
    (id: string, title: string) => {
      const clean = title.trim();
      if (!clean) return;
      setSongs((prev) =>
        prev.map((entry) =>
          entry.score.id === id
            ? { ...entry, score: { ...entry.score, title: clean } }
            : entry,
        ),
      );
      showToast(`Renamed sheet to “${clean}”.`, 'success');
    },
    [showToast],
  );

  const openAiComposer = useCallback(() => {
    playback.pause();
    setAiOpen(true);
  }, [playback]);

  const openDeepSeekComposer = useCallback(() => {
    playback.pause();
    setDeepseekOpen(true);
  }, [playback]);

  const handleAiCreate = useCallback(
    (composition: AiComposition) => {
      const entry: SongEntry = { score: composition.score, kind: 'ai' };
      setSongs((prev) => [...prev, entry]);
      setCurrentId(entry.score.id);
      setAiOpen(false);
      setViewMode('sheet');
      setTab('studio');
      showToast(
        `AI sheet “${composition.meta.title}” added — press Listen to hear it.`,
        'success',
      );
    },
    [showToast],
  );

  const handleDeepSeekCreate = useCallback(
    (composition: AiComposition) => {
      const entry: SongEntry = {
        score: { ...composition.score, id: `deepseek-${Date.now().toString(36)}` },
        kind: 'deepseek',
      };
      setSongs((prev) => [...prev, entry]);
      setCurrentId(entry.score.id);
      setDeepseekOpen(false);
      setViewMode('sheet');
      setTab('studio');
      showToast(
        `DeepSeek sheet “${composition.meta.title}” added — press Listen to hear it.`,
        'success',
      );
    },
    [showToast],
  );

  const openOnlineSearch = useCallback(() => {
    playback.pause();
    setOnlineOpen(true);
  }, [playback]);

  const handleOnlineImport = useCallback(
    (imported: Score, result: OnlineSheetResult) => {
      const entry: SongEntry = {
        kind: 'online',
        score: { ...imported, id: `online-${Date.now().toString(36)}` },
      };
      setSongs((prev) => [...prev, entry]);
      setCurrentId(entry.score.id);
      setOnlineOpen(false);
      setViewMode('sheet');
      setTab('studio');
      showToast(
        `Imported “${entry.score.title}” from Wikimedia Commons${
          result.artist ? ` (${result.artist})` : ''
        } — press Listen to hear it.`,
        'success',
      );
    },
    [showToast],
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

  // ---- native shell (Android): splash/status bar, back button, wake lock ----
  useEffect(() => {
    void setupNativeShell();
  }, []);

  useNativePause(() => {
    playback.pause();
    if (recorder.recording) recorder.stop();
  });

  useWakeLock(playback.isPlaying || activeGame !== null || recorder.recording);

  useAndroidBackButton(() => {
    if (recorder.recording) {
      recorder.stop();
      return true;
    }
    if (activeGame) {
      exitGame();
      return true;
    }
    if (tab === 'games') {
      setTab('studio');
      return true;
    }
    if (playback.isPlaying) {
      playback.pause();
      return true;
    }
    return false;
  });

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
            <SoundMeter engine={engine} />
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
                onRename={handleRenameSong}
                onAiCompose={openAiComposer}
                onDeepSeek={openDeepSeekComposer}
                onOnlineSearch={openOnlineSearch}
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
                  <button
                    type="button"
                    className="ai-cta"
                    onClick={openAiComposer}
                    title="Generate a new piano sheet with the offline local composer"
                  >
                    ✦ AI Compose
                  </button>
                  <button
                    type="button"
                    className="deepseek-cta"
                    onClick={openDeepSeekComposer}
                    title="Arrange a song or compose in a composer's style with DeepSeek"
                  >
                    ◇ DeepSeek
                  </button>
                  <button
                    type="button"
                    className="online-cta"
                    onClick={openOnlineSearch}
                    title="Search public-domain sheets and MIDI online"
                  >
                    ⌕ Online
                  </button>
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
                    <button type="button" onClick={() => void handleExport('pdf')}>
                      PDF
                    </button>
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
                  <Suspense fallback={<div className="view-loading">Preparing sheet music…</div>}>
                    <SheetView
                      score={score}
                      currentBeat={playback.currentBeat}
                      activeMidis={activeMidis}
                      follow={playback.isPlaying}
                      onSeek={playback.seek}
                      className="sheet-view"
                    />
                  </Suspense>
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
          <Suspense fallback={<div className="view-loading game-loading">Preparing game…</div>}>
            <GameView score={score} engine={engine} onExit={exitGame} />
          </Suspense>
        )}
        {tab === 'games' && activeGame === 'quiz' && (
          <Suspense fallback={<div className="view-loading game-loading">Preparing game…</div>}>
            <QuizView engine={engine} onExit={exitGame} />
          </Suspense>
        )}
      </main>

      <input
        ref={fileInputRef}
        type="file"
        accept={isNativeApp() ? '*/*' : '.mid,.midi,.musicxml,.xml,.mxl,.json'}
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

      {aiOpen && (
        <AiComposer onClose={() => setAiOpen(false)} onCreate={handleAiCreate} />
      )}

      {deepseekOpen && (
        <DeepSeekComposer
          onClose={() => setDeepseekOpen(false)}
          onCreate={handleDeepSeekCreate}
        />
      )}

      {onlineOpen && (
        <OnlineSheets
          initialQuery={score.title}
          onClose={() => setOnlineOpen(false)}
          onImport={handleOnlineImport}
        />
      )}
    </div>
  );
}
