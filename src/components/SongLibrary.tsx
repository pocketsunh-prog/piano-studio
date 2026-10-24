import type { Score } from '../music/types';
import { scoreDurationSeconds } from '../music/timing';

export type SongKind = 'demo' | 'imported' | 'recording' | 'ai';

export interface SongEntry {
  score: Score;
  kind: SongKind;
}

export interface SongLibraryProps {
  songs: SongEntry[];
  currentId: string;
  importing: boolean;
  onSelect: (id: string) => void;
  onImport: () => void;
  onRemove: (id: string) => void;
  onAiCompose: () => void;
}

function formatDuration(score: Score): string {
  const seconds = scoreDurationSeconds(score);
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

const KIND_LABEL: Record<SongKind, string> = {
  demo: 'Demo',
  imported: 'Imported',
  recording: 'Recording',
  ai: 'AI',
};

export function SongLibrary({
  songs,
  currentId,
  importing,
  onSelect,
  onImport,
  onRemove,
  onAiCompose,
}: SongLibraryProps) {
  return (
    <div className="library">
      <div className="panel-heading">
        <h2>Library</h2>
        <span className="count-pill">{songs.length}</span>
      </div>
      <button type="button" className="btn import-button" onClick={onImport} disabled={importing}>
        {importing ? 'Importing…' : '＋ Import sheet (.mid, .xml, .mxl)'}
      </button>
      <button type="button" className="btn ai-compose-button" onClick={onAiCompose}>
        <span aria-hidden="true">✦</span> AI Compose
      </button>

      <ul className="song-list">
        {songs.map(({ score, kind }) => {
          const active = score.id === currentId;
          return (
            <li key={score.id}>
              <div className={`song-item ${active ? 'active' : ''}`}>
                <button type="button" className="song-select" onClick={() => onSelect(score.id)}>
                  <span className="song-title">{score.title}</span>
                  <span className="song-meta">
                    {score.composer || 'Unknown'} · {score.notes.length} notes · {formatDuration(score)}
                  </span>
                  <span className={`song-kind ${kind}`}>{KIND_LABEL[kind]}</span>
                </button>
                {kind !== 'demo' && (
                  <button
                    type="button"
                    className="song-remove"
                    onClick={() => onRemove(score.id)}
                    aria-label={`Remove ${score.title}`}
                    title="Remove from library"
                  >
                    ×
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="library-tip">
        <strong>Play along</strong>
        <span>
          Press the glowing keys as they light up, or use your computer keyboard (A–K, W/E/T/Y/U).
          Z/X shift octaves.
        </span>
      </div>
    </div>
  );
}
