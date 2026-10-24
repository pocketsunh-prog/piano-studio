/**
 * STUB — owned by the `games` teammate.
 * Replace with the falling-notes rhythm game (see CONTRACT.md).
 */
import type { Score } from '../music/types';
import type { PianoEngine } from '../audio/PianoEngine';

export interface GameViewProps {
  score: Score;
  engine: PianoEngine;
  onExit: () => void;
  onActiveKeysChange?: (midis: number[]) => void;
}

export function GameView({ onExit }: GameViewProps) {
  return (
    <div style={{ padding: 40, color: 'var(--text)' }}>
      <p>Rhythm game loading…</p>
      <button type="button" onClick={onExit}>Back</button>
    </div>
  );
}
