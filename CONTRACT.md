# Piano Studio — build contract (read this first)

A browser piano studio: playable 88-key piano with realistic Web Audio sound, MIDI/MusicXML
sheet import, notation + falling-note visualization, sheet/MIDI export, and practice games.

Stack: Vite 7 + React 19 + TypeScript (strict) + VexFlow 4.2.5 + fflate. Tests: Vitest (jsdom).
No runtime network access: everything must work offline after build.

Commands: `npm install` (already done), `npm run dev`, `npm run build`, `npm test`, `npm run typecheck`.

## Ownership (do not write outside your scope)

| Scope | Owner |
| --- | --- |
| `src/audio/**` | **audio-eng** teammate |
| `src/music/formats/**` | **sheet-io** teammate |
| `src/sheet/**` | **notation** teammate |
| `src/game/**` | **games** teammate |
| Everything else (`src/App.tsx`, `src/main.tsx`, `src/components/**`, `src/music/types.ts`, `timing.ts`, `pitch.ts`, `score.ts`, `demo.ts`, `styles.css`, config) | **Lead** |

- Never edit `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/music/types.ts`,
  `src/music/timing.ts`, `src/music/pitch.ts`, `src/music/score.ts`, or files outside your scope.
- You may add files inside your scope and import React helpers from `react`.
- You may add your own CSS file inside your scope and import it from your component. Use the CSS
  variables below rather than re-theming the app.
- Do not start long-running servers on port 5173 (Lead uses it). If you must visually check your
  work, build/preview on a unique port (audio-eng 5174, sheet-io 5175, notation 5176, games 5177)
  and kill the process when done. Chrome is at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`; headless screenshot:
  `chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1440,900 --screenshot=<abs.png> --virtual-time-budget=5000 <url>`
  then inspect with the read_image tool.

## Shared score model (already implemented — import, never redefine)

`src/music/types.ts`:

```ts
interface NoteEvent { id: string; midi: number; start: number; duration: number; velocity: number;
                      hand: 'left' | 'right'; track?: number; voice?: number }
interface Score {
  id: string; title: string; composer: string; notes: NoteEvent[];        // beats, unsorted is tolerated
  tempo: { beat: number; bpm: number }[];                                 // sorted, first at 0
  timeSignatures: { beat: number; numerator: number; denominator: number }[];
  keySignature: { fifths: number; mode: 'major' | 'minor' };
  ppq: number; source: 'builtin' | 'midi' | 'musicxml' | 'recording'; lengthBeats: number;
}
```

Invariants: `start >= 0`, `duration > 0`, `midi` 0..127, velocity 1..127, `lengthBeats >= notes end`.
All positions are **quarter-note beats**; seconds come from `src/music/timing.ts`:
`beatToSeconds(score, beat)`, `secondsToBeat(score, seconds)`, `scoreDurationSeconds(score)`,
`buildMeasures(score)`, `tempoAt`, `timeSignatureAt`.
Pitch helpers in `src/music/pitch.ts`: `midiToName` (60 = "C4"), `nameToMidi`, `midiToFrequency`,
`isBlackKey`, `midiToKeyName`, `MIN_PIANO_MIDI` (21), `MAX_PIANO_MIDI` (108).
`src/music/score.ts` exports `createScore(partial)`, `normalizeScore(score)`, `notesEndBeat`,
`transposeScore(score, semitones)`, `subsetScore(score, fromBeat, toBeat)`.

TypeScript: strict, no `any` in public APIs, no non-null `!` on external data. Handle malformed
input defensively (imported files are untrusted): throw `Error` with a human-readable message for
invalid files; never hang or allocate unbounded memory on hostile input (cap note counts).

## Module APIs (exact)

### 1. Audio — `src/audio/`

`src/audio/PianoEngine.ts` exports:

```ts
export interface PianoEngineOptions {
  volume?: number;    // master 0..1, default 0.8
  reverbMix?: number; // 0..1, default 0.22
  brightness?: number; // 0..1, default 0.5 (tone/timbre)
}
export type EngineState = 'suspended' | 'running' | 'closed';

export class PianoEngine {
  constructor(options?: PianoEngineOptions);
  get state(): EngineState;
  get context(): AudioContext | null;
  now(): number;                                   // AudioContext.currentTime (0 when not started)
  ensureStarted(): Promise<void>;                  // create/resume AudioContext; call inside a user gesture
  scheduleNote(midi: number, velocity: number, when: number, duration: number): void; // abs audio seconds
  noteOn(midi: number, velocity?: number): void;   // immediate, for live playing
  noteOff(midi: number): void;
  sustain(on: boolean): void;                      // damper pedal
  setVolume(v: number): void;                      // 0..1
  setReverbMix(v: number): void;                   // 0..1
  metronomeClick(when: number, accent?: boolean): void;
  stopAll(): void;                                 // cancel scheduled voices + release live notes
  dispose(): void;
}
```

Quality bar: piano must actually sound like a piano — additive/inharmonic partials, per-note
decay envelopes, velocity-dependent brightness, subtle hammer/attack noise, stereo spread per key,
and a generated convolution or feedback-delay reverb. Lookahead scheduling must stay CPU-safe
(do not create thousands of nodes for a whole song at once; the Lead's transport schedules with
~1 s lookahead, but engine must tolerate it). Live noteOn/noteOff and scheduled notes must not leak
voices; cap concurrent voices. `ensureStarted()` must be safe to call repeatedly and after
`dispose()` should throw a clear error only if used.

`src/audio/selftest.ts` exports `runAudioSelfTest(): Promise<{ name: string; peak: number; rms: number;
durationSec: number; sampleRate: number }[]>`, rendering a few notes/chords through
`OfflineAudioContext` with the same voice-building code and returning signal levels. It must be
importable in the browser and produce non-silent peaks (peak > 0.02) for C4/E4/G4/C5 and a C major
chord. The Lead will expose it as `window.__pianoAudioTest` for a headless check. Keep it out of the
critical path (dynamic import is fine).

`src/audio/index.ts` re-exports `PianoEngine`, `PianoEngineOptions`.

### 2. Sheet formats — `src/music/formats/`

```ts
// midi.ts
export function parseMidi(data: ArrayBuffer, fallbackTitle?: string): Score;
export function writeMidi(score: Score): Uint8Array;

// musicxml.ts
export function parseMusicXml(xml: string, fallbackTitle?: string): Score;
export function writeMusicXml(score: Score): string;

// quantize.ts
export function quantizeScore(score: Score, grid?: number): Score; // default 1/16 beat grid = 0.25? see below
export function quantizeNotes(notes: NoteEvent[], grid: number): NoteEvent[];

// import.ts
export function parseScoreFile(fileName: string, data: ArrayBuffer): Promise<Score>;
// handles .mid/.midi, .musicxml/.xml, .mxl (zip: use fflate.unzipSync, find *.xml / *.musicxml)

// export.ts
export type ExportFormat = 'musicxml' | 'midi' | 'json';
export function buildExport(score: Score, format: ExportFormat): { fileName: string; mime: string; data: string | Uint8Array };
export function scoreToJson(score: Score): string;
export function scoreFromJson(text: string): Score;
```

Requirements:
- MIDI: format 0/1, running status, meta events (tempo 0x51, time signature 0x58, key signature
  0x59, track name), note on/off, channels. Merge all tracks; derive `hand` from channel/track pitch
  split (staff 2 / low track = left). Normalize lengths. Reject non-MIDI gracefully.
- MusicXML: `<score-partwise>`; support `<divisions>`, attributes (key/time/clef/staves),
  note/rest/chord/voice/staff, `<duration>`, `<type>`/dots only as fallback, ties (merge tied notes
  into one), `<backup>`/`<forward>`, `<sound tempo>`, `<direction>` metronome, part-list titles,
  `work-title`. Both `<staff>1</staff>` (right) and 2 (left) map to hands; fall back to pitch split.
  Compressed `.mxl` handled in `parseScoreFile`.
- Writer: valid parseable MusicXML (re-parse must reproduce the same notes within 1e-6 beats) and
  standard MIDI with tempo/time signature. Include title/composer metadata.
- Quantize: `quantizeScore(score, grid)` snaps starts/durations to a musical grid expressed in
  beats (default `1/16` **measure fraction**: call as `quantizeScore(score, 0.25)` for sixteenths).
  Preserve total ordering, merge zero-length results sensibly, recompute `lengthBeats`. It is fine
  for quantization to be "best effort" for triplets.
- Tests required (`src/music/formats/*.test.ts`): MIDI roundtrip, MusicXML roundtrip for
  chords/hands/tempo, `.mxl` unzip via a generated zip, malformed-input rejection, quantization.

### 3. Notation — `src/sheet/`

`src/sheet/SheetView.tsx` exports:

```tsx
export interface SheetViewProps {
  score: Score;
  currentBeat?: number;     // playback position (auto-highlight + follow)
  activeMidis?: number[];   // currently sounding keys -> highlight noteheads
  follow?: boolean;         // auto-scroll to current system (default true)
  onSeek?: (beat: number) => void; // optional click-to-seek by measure
  className?: string;
}
export function SheetView(props: SheetViewProps): React.ReactElement | null;
```

Requirements: grand staff (treble + bass), key signature, time signature (with changes), barlines,
noteheads with accidentals, stems/beams, dots, rests to fill measures, ledger lines. Split notes
into the two staves by `hand` (fallback pitch split at 60). Handle simple polyphony by making at
most two voices per staff (chord notes sharing a start; overlapping independent lines).
Quantize to a 1/16 grid for display (use `quantizeScore` from formats or local logic; do not mutate
the input score). Layout in systems (e.g. 4 measures per row, responsive width) inside a scroll
container; auto-scroll smoothly to the active system when `follow`. Highlight notes whose onset is
within the current beat window (and `activeMidis` matches) in amber. Clicking a measure calls
`onSeek(measure start beat)`. Rendering a long score must stay responsive: cap initial rendering
(e.g. first 96 measures, extend on scroll or render all under 400 measures) and re-render
highlights without a full redraw where possible. Clean up SVG on unmount. Also export:

```ts
export function renderScoreSvg(score: Score, options?: { width?: number }): string; // standalone .svg text
```

Tests: pure helpers (`toVexDuration`, `groupIntoVoices`, `measureify`) — not DOM-heavy snapshots.

### 4. Games — `src/game/`

`src/game/GameView.tsx`:

```tsx
export interface GameViewProps {
  score: Score;
  engine: PianoEngine;                       // from ../../audio/PianoEngine
  onExit: () => void;
  onActiveKeysChange?: (midis: number[]) => void; // tell App which piano keys to glow
}
export function GameView(props: GameViewProps): React.ReactElement;
```

Falling-notes rhythm game: choose a short segment/all of `score`; 3-2-1 count-in (metronome via
`engine.metronomeClick`), notes fall in pitch lanes toward a hit line, player presses keys
(mouse/touch via `onPointerDown` lanes or its own on-screen keyboard; also `keydown` physical keys
with the shared mapping below). Scoring: perfect ≤60 ms, great ≤110 ms, good ≤170 ms, else miss when
late >220 ms; combo, max combo, score with multiplier, accuracy %, hit/miss counters, progress bar.
Judgement popups (Perfect/Great/Good/Miss), colored lane glow, song end results screen with
"Retry" / "Back to library". Tempo control (0.5×–1.25×) and an "assist" toggle that auto-plays the
target note quietly so learners hear the tune; a "guide" toggle for a metronome. Pause/resume.
Use `PianoEngine.scheduleNote` for guide notes and `noteOn` for the player's own key sound (the App
also sends live notes through the same engine, so do not double-trigger: rely on App's keyboard
input for the player's sound, and use onActiveKeysChange for visuals). Listen to the global
`piano:noteon` / `piano:noteoff` custom events? **Preferred:** GameView adds its own `window`
`keydown`/`keyup` listener for the QWERTY mapping (shared constant below) and also accepts pointer
input on its lanes; sound via `engine.noteOn(midi, 90)` on press and `engine.noteOff(midi)` on
release. The App's piano keyboard is hidden in game view, so no double sound.

Also `src/game/QuizView.tsx`:

```tsx
export interface QuizViewProps {
  engine: PianoEngine;
  onExit: () => void;
  onActiveKeysChange?: (midis: number[]) => void;
}
export function QuizView(props: QuizViewProps): React.ReactElement;
```

Ear/keyboard training quiz with two modes: "Hear the note" (engine plays a random note in C4–C5,
user clicks the key; name hidden) and "Find the key" (note name shown, silent until correct), using
its own on-screen key strip (2 octaves) plus physical keys. 10 rounds per run, streak, score, timing
bonus, feedback ("That was D4" / "Correct!"), results screen. Accessibility: aria-live feedback,
focusable buttons.

Pure logic in `src/game/scoring.ts` (hit judgement windows + combo/score state) and
`src/game/quizLogic.ts` (round generation/validation), with Vitest tests. Game UI gets a dark
canvas look; import `GameView.css`. Keyboard mapping constant:

```
white: a s d f g h j k  -> C D E F G A B C (octave 4), black: w e t y u -> C# D# F# G# A#
octave shift: z (down) / x (up); range 1..7.
```

## Styling variables (defined by Lead in `src/styles.css`)

`--bg`, `--bg-elev`, `--panel`, `--panel-2`, `--text`, `--muted`, `--border`, `--accent`,
`--accent-2`, `--perfect`, `--great`, `--good`, `--miss`, `--key-white`, `--key-black`, `--radius`.
Use `color-scheme: dark` conventions; no external fonts (system font stack only). Mobile-friendly:
the app is usable at 1280×800 and degrades to 800px wide.

## Integration notes

- `src/App.tsx` owns layout, library, import/export UI, transport, keyboard, piano-roll and quiz
  routing. It imports your modules and passes `score`, `engine`, callbacks. Do not change its API.
- Live notes: App's `Keyboard` calls `engine.noteOn/off`; playback transport schedules via
  `engine.scheduleNote` with absolute `engine.now()`-based times.
- If you must deviate from an API above, message the Lead first and keep the exported types stable.
- Definition of done: your tests pass (`npx vitest run src/<your-dir>`), `npx tsc --noEmit` shows no
  errors in your files, module works in the integrated app, and you post a short completion message
  to the Lead (files, behaviors, test counts, any deviations).
