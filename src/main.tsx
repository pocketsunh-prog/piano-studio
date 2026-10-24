import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element missing');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Audio QA hook: open `?audiotest` to render piano notes through an
// OfflineAudioContext and print the measured signal levels into the DOM.
// Also exposed on `window` for manual browser-console checks.
const audioWindow = window as unknown as { __pianoAudioTest?: () => Promise<unknown> };
audioWindow.__pianoAudioTest = async () => {
  const { runAudioSelfTest } = await import('./audio/selftest');
  return runAudioSelfTest();
};

if (new URLSearchParams(window.location.search).has('audiotest')) {
  const output = document.createElement('pre');
  output.id = 'audio-selftest';
  output.style.cssText =
    'position:fixed;inset:auto 8px 8px 8px;z-index:9999;max-height:40vh;overflow:auto;background:#111;color:#9f9;padding:8px;font:11px monospace;white-space:pre-wrap';
  output.textContent = 'AUDIO_SELFTEST_PENDING';
  document.body.appendChild(output);
  import('./audio/selftest')
    .then(({ runAudioSelfTest }) => runAudioSelfTest())
    .then((results) => {
      output.textContent = `AUDIO_SELFTEST ${JSON.stringify(results)}`;
      document.title = 'AUDIO_SELFTEST_DONE';
    })
    .catch((error: unknown) => {
      output.textContent = `AUDIO_SELFTEST_ERROR ${
        error instanceof Error ? error.message : String(error)
      }`;
    });
}

async function runSheetRoundTripSelfTest(): Promise<unknown[]> {
  const [{ DEMO_SONGS }, exportModule, { parseScoreFile }] = await Promise.all([
    import('./music/demo'),
    import('./music/formats/export'),
    import('./music/formats/import'),
  ]);
  const results: unknown[] = [];
  for (const score of DEMO_SONGS.slice(0, 3)) {
    const xml = exportModule.buildExport(score, 'musicxml');
    const xmlBytes = new TextEncoder().encode(xml.data as string);
    const parsedXml = await parseScoreFile('roundtrip.musicxml', xmlBytes.buffer as ArrayBuffer);

    const midi = exportModule.buildExport(score, 'midi');
    const midiBytes = midi.data as Uint8Array;
    const midiBuffer = midiBytes.buffer.slice(
      midiBytes.byteOffset,
      midiBytes.byteOffset + midiBytes.byteLength,
    ) as ArrayBuffer;
    const parsedMidi = await parseScoreFile('roundtrip.mid', midiBuffer);

    const json = exportModule.buildExport(score, 'json');
    const parsedJson = exportModule.scoreFromJson(json.data as string);

    results.push({
      title: score.title,
      originalNotes: score.notes.length,
      musicxmlNotes: parsedXml.notes.length,
      midiNotes: parsedMidi.notes.length,
      jsonNotes: parsedJson.notes.length,
    });
  }
  return results;
}

if (new URLSearchParams(window.location.search).has('selftest')) {
  const output = document.createElement('pre');
  output.id = 'sheet-selftest';
  output.style.cssText =
    'position:fixed;inset:auto 8px 8px 8px;z-index:9999;max-height:40vh;overflow:auto;background:#111;color:#9cf;padding:8px;font:11px monospace;white-space:pre-wrap';
  output.textContent = 'SHEET_SELFTEST_PENDING';
  document.body.appendChild(output);
  runSheetRoundTripSelfTest()
    .then((results) => {
      output.textContent = `SHEET_SELFTEST ${JSON.stringify(results)}`;
      document.title = 'SHEET_SELFTEST_DONE';
    })
    .catch((error: unknown) => {
      output.textContent = `SHEET_SELFTEST_ERROR ${
        error instanceof Error ? error.message : String(error)
      }`;
    });
}
