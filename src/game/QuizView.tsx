/**
 * STUB — owned by the `games` teammate.
 * Replace with the ear-training / key-finding quiz (see CONTRACT.md).
 */
import type { PianoEngine } from '../audio/PianoEngine';

export interface QuizViewProps {
  engine: PianoEngine;
  onExit: () => void;
  onActiveKeysChange?: (midis: number[]) => void;
}

export function QuizView({ onExit }: QuizViewProps) {
  return (
    <div style={{ padding: 40, color: 'var(--text)' }}>
      <p>Ear training loading…</p>
      <button type="button" onClick={onExit}>Back</button>
    </div>
  );
}
