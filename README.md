# Piano Studio

A browser piano studio: play an 88-key piano with synthesized sound, read along with real
sheet music, import/export MIDI and MusicXML, and practice with two games. It also ships as a
native **Android app** (Capacitor) — see [Android app](#android-app) below.

![Piano Studio playing Twinkle Twinkle](docs/studio-playing.png)

## Features

**Play**
- Full 88-key piano (A0–C8) with mouse, touch (multi-pointer) or computer keyboard.
- Realistic, velocity-sensitive Web Audio piano synthesis: inharmonic partials, per-note decay,
  hammer noise, stereo spread and reverb — no samples to download, works fully offline.
- Optional Web MIDI keyboard input (`Connect MIDI`) — play and see the keys light up.
- Live note readout shows exactly which keys are sounding, and both hands are colour-coded.
- Damper pedal toggle, octave shift, QWERTY labels on keys.

**Read**
- Grand-staff notation view rendered with VexFlow: key/time signatures, accidentals, beams, rests,
  ledger lines, two voices per staff, hands split across treble and bass.
- Playback highlights the notes that are sounding and auto-scrolls to the current system.
- Click any measure to seek; click the falling-note view anywhere to seek too.
- Falling-note piano-roll view aligned to a live keyboard strip.
- Transport: play/pause, stop, seek, tempo 50–150 %, loop, metronome, bar.beat readout.

**Import / export**
- Import `.mid`, `.midi`, `.musicxml`, `.xml`, `.mxl` (compressed MusicXML) and Piano Studio `.json`.
- Export the current score as **MusicXML** (sheet), **MIDI**, **JSON** (project) or **SVG** (sheet).
- Recording: hit Record, play on the piano, hit Record again — your take is quantized into a score
  that you can read, play back and export as sheet music.
- Demo library: Twinkle Twinkle, Ode to Joy, Für Elise, Canon in D, C major scale.
- Imported and recorded songs persist in the browser.

**Practice games**
- **Falling Notes** — notes fall toward the hit line; press the matching key. Perfect/great/good
  timing windows, combo, multiplier, accuracy, results rank, per-run length (short/full), tempo
  control, metronome and an assist mode that quietly plays the target notes.
- **Ear & Key Training** — 10 rounds, two modes: hear a note and find it, or find a named key.
  Streak, score, timing bonus, keyboard and on-screen input.

![Falling Notes game](docs/game-playing.png)

![Ear & Key Training](docs/ear-training.png)

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build and tests:

```bash
npm run build      # type-check + bundle to dist/
npm run preview    # serve the build (http://localhost:4173)
npm test           # Vitest suite
```

The app needs a modern browser with Web Audio (Chrome, Edge, Firefox, Safari). Audio starts after
the first click/keypress because of browser autoplay rules. Web MIDI is optional and depends on
browser support.

## Android app

The app is wrapped with [Capacitor](https://capacitorjs.com) and runs as a native Android app with
a dark splash screen, status-bar theming, hardware back navigation, screen wake-lock while
playing, and Android share-sheet exports.

Signed release artifacts are included in `release/` (gitignored build output):

| Artifact | Size | Use |
| --- | --- | --- |
| `release/PianoStudio-1.0.0-release.apk` | 6.0 MiB | sideload / direct install |
| `release/PianoStudio-1.0.0-release.aab` | 5.8 MiB | Google Play Console upload |
| `release/SHA256SUMS.txt` | — | integrity checksums |

```text
Package      com.pianostudio.app
Version      1.0.0 (versionCode 1)
Min SDK      24 (Android 7.0+), target SDK 36
APK SHA-256  9817fc61eba9b11515210bd732c66db62600bd5599aa6ec82ee3797747537709
AAB SHA-256  4b703430d663e3f2906d13be3e50e880d9efdfb4fcf4f43c59c74d25eedeb1f5
Cert SHA-256 8D:39:AE:54:D9:F8:40:71:B8:3F:0A:6E:B7:9C:56:1C:10:19:F1:A0:8A:9D:FB:93:BF:83:61:AC:7B:12:7A:EA
```

Install the signed release over USB debugging, or copy the APK to the phone and open it (allow
“install unknown apps” for your file manager):

```bash
adb install -r release/PianoStudio-1.0.0-release.apk
```

If an older debug build is installed, uninstall it first — it uses a different signing key:

```bash
adb uninstall com.pianostudio.app
```

### Signed release builds

Release builds are signed with the RSA-2048 keystore at
`android/piano-studio-release.keystore` (alias `piano-studio`, certificate valid until 2054).
The credentials are read from `android/keystore.properties`; **both files are gitignored — back
them up**, because Android will only accept future updates signed with the same key.

`android/keystore.properties.example` is the template. The Gradle config automatically uses the
release keystore when `keystore.properties` exists; otherwise `assembleRelease` produces an
unsigned APK and the debug build is unaffected.

```bash
npm run android:release   # web build → cap sync → assembleRelease + bundleRelease
# APK: android/app/build/outputs/apk/release/app-release.apk
# AAB: android/app/build/outputs/bundle/release/app-release.aab

# verify the signature and checksum
apksigner verify --print-certs android/app/build/outputs/apk/release/app-release.apk
sha256sum release/PianoStudio-1.0.0-release.apk
```

On macOS/Linux, use `./gradlew assembleRelease bundleRelease` instead of the Windows
`gradlew.bat` wrapper used by the npm scripts.

Debug build (debug keystore, WebView debugging enabled):

```bash
npm run android:build     # → android/app/build/outputs/apk/debug/app-debug.apk
npm run android:open      # open the project in Android Studio
```

### Android behaviour

- **Back button**: closes a game → returns to the games page → returns to Studio → exits the app.
- **Exports** (MusicXML/MIDI/JSON/SVG): opened through the Android share sheet so you can save to
  Files, Drive, send by email, etc. Import uses the system file picker.
- **Audio** starts on the first tap (WebView autoplay rules) and pauses when the app is backgrounded.
- **Rotation**: portrait is a sheet + keyboard layout; landscape is a compact sheet + full-width
  88-key keyboard practice view.

| Portrait | Landscape |
| --- | --- |
| ![Android portrait](docs/android-portrait.png) | ![Android landscape](docs/android-landscape.png) |

## Controls

| Action | Input |
| --- | --- |
| Play notes | Click/touch keys, or `A S D F G H J K` (white) and `W E T Y U` (black) |
| Octave shift | `Z` / `X`, or the − / + buttons |
| Play / pause | `Space`, or the transport button |
| Seek | Click a measure in the sheet, click the piano roll, or use the seek slider |
| Pedal / labels | Buttons above the keyboard |
| Games | `Games` tab → choose a game |

The QWERTY mapping is relative to the octave shown above the keyboard (`Oct 4` = C4). Game views
use the same mapping.

## Format notes / known limitations

- Internal scores are stored in quarter-note beats with a tempo map; MIDI ticks and MusicXML
  divisions are converted on import.
- The score model has a single global key signature; key changes later in an imported file are
  shown/exported with the first key signature.
- MusicXML has no velocity, so imported notes use a default velocity; MIDI/recorded velocities are
  preserved.
- MusicXML export writes sharps for black keys and snaps time-signature changes to bar lines.
- `.mxl` import expects a UTF-8 MusicXML score; `score-timewise` files are rejected with a clear
  message.
- SVG export renders the notation; MusicXML is the editable/interchange format.

## Project layout

```
src/
  App.tsx                 app shell, library, transport wiring, import/export UI
  components/             keyboard, piano roll, transport, song library, games landing
  hooks/                  piano engine lifecycle, playback scheduler, QWERTY/MIDI input, recorder
  audio/                  Web Audio piano engine + synthesis + offline self-test
  music/                  score model, timing/tempo math, pitch helpers, demo songs, recording
  music/formats/          MIDI + MusicXML parsers/writers, .mxl import, quantization, JSON
  sheet/                  VexFlow grand-staff renderer, layout, highlighting, SVG export
  game/                   falling-notes game, ear/key quiz, scoring and quiz logic
  styles.css              theme and layout
```

Playback is a look-ahead scheduler: notes are scheduled into the AudioContext ~0.9 s ahead while a
30 fps UI clock drives highlighting. All musical positions are beats; seconds are derived through
`src/music/timing.ts`, so tempo changes and seeking stay consistent.

## Verification

- Unit tests cover timing/tempo math, pitch/key signatures, score normalisation, recording
  quantization, MIDI/MusicXML round-trips, `.mxl` import, quantization, VexFlow layout helpers,
  audio voice/engine behaviour and game scoring/quiz logic.
- The audio engine has an offline self-test (`?audiotest` in the app) that renders individual notes
  and a chord through `OfflineAudioContext` and reports peak/RMS levels.
- The app was exercised end-to-end in headless Chrome: playback highlights keys and advances the
  clock, the falling-notes game scores key presses, the quiz advances, and every export format
  downloads and re-imports.
- The Android build was installed on an Android 14 emulator: audio output was confirmed through the
  Android audio stack (48 kHz stereo AAudio stream), playback highlighted 4 keys and advanced the
  transport, the falling-notes canvas rendered, MusicXML import via the system picker added the
  score (78 notes), the share sheet opened with the exported `.musicxml`, hardware Back navigated
  game → games page → Studio → exit, and both portrait and landscape layouts were checked.
- The signed 1.0.0 release build was verified with `apksigner` (APK Signature Scheme v2, RSA-2048)
  and installed cleanly on a fresh Android 14 emulator.

## Credits

Demo songs are traditional / public domain. Built with React, Vite, TypeScript, VexFlow and fflate.
