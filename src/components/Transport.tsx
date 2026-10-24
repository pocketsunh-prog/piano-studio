export interface TransportProps {
  isPlaying: boolean;
  currentBeat: number;
  lengthBeats: number;
  currentSeconds: number;
  durationSeconds: number;
  barLabel: string;
  tempoScale: number;
  loop: boolean;
  metronome: boolean;
  recording: boolean;
  recordElapsedMs: number;
  disabled?: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onSeek: (beat: number) => void;
  onTempoScale: (value: number) => void;
  onToggleLoop: () => void;
  onToggleMetronome: () => void;
  onToggleRecord: () => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function Transport({
  isPlaying,
  currentBeat,
  lengthBeats,
  currentSeconds,
  durationSeconds,
  barLabel,
  tempoScale,
  loop,
  metronome,
  recording,
  recordElapsedMs,
  disabled,
  onPlayPause,
  onStop,
  onSeek,
  onTempoScale,
  onToggleLoop,
  onToggleMetronome,
  onToggleRecord,
}: TransportProps) {
  return (
    <div className="transport">
      <div className="transport-row">
        <div className="transport-main">
          <button
            type="button"
            className="play-button primary"
            onClick={onPlayPause}
            disabled={disabled}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <button type="button" className="stop-button" onClick={onStop} aria-label="Stop">
            ■
          </button>
          <div className="time-display">
            <strong>{formatTime(currentSeconds)}</strong>
            <span>/ {formatTime(durationSeconds)}</span>
          </div>
          <div className="bar-display" title="Bar . beat">
            {barLabel}
          </div>
        </div>

        <div className="transport-toggles">
          <button
            type="button"
            className={`toggle ${loop ? 'on' : ''}`}
            onClick={onToggleLoop}
            aria-pressed={loop}
            title="Loop the whole piece"
          >
            ↻ Loop
          </button>
          <button
            type="button"
            className={`toggle ${metronome ? 'on' : ''}`}
            onClick={onToggleMetronome}
            aria-pressed={metronome}
            title="Metronome click on every beat"
          >
            ♩ Click
          </button>
          <button
            type="button"
            className={`toggle record ${recording ? 'on' : ''}`}
            onClick={onToggleRecord}
            aria-pressed={recording}
            title="Record your playing, then export it as sheet music"
          >
            <span className="record-dot" /> {recording ? formatTime(recordElapsedMs / 1000) : 'Record'}
          </button>
        </div>
      </div>

      <div className="transport-row transport-seek-row">
        <input
          type="range"
          min={0}
          max={Math.max(0.01, lengthBeats)}
          step={0.01}
          value={Math.min(currentBeat, Math.max(0.01, lengthBeats))}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="Seek position"
          className="seek-slider"
          disabled={disabled}
        />
        <div className="tempo-control">
          <label htmlFor="tempo-range">Tempo</label>
          <input
            id="tempo-range"
            type="range"
            min={0.5}
            max={1.5}
            step={0.05}
            value={tempoScale}
            onChange={(event) => onTempoScale(Number(event.target.value))}
            aria-label="Playback tempo"
          />
          <span className="tempo-value">{Math.round(tempoScale * 100)}%</span>
        </div>
      </div>
    </div>
  );
}
