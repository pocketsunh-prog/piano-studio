/**
 * STUB — owned by the `notation` teammate.
 * Replace with the VexFlow grand-staff renderer (see CONTRACT.md).
 */
import type { Score } from '../music/types';

export interface SheetViewProps {
  score: Score;
  currentBeat?: number;
  activeMidis?: number[];
  follow?: boolean;
  onSeek?: (beat: number) => void;
  className?: string;
}

export function SheetView({ score, className }: SheetViewProps) {
  return (
    <div className={className ?? ''} style={{ padding: 24, color: 'var(--muted)' }}>
      Notation renderer loading… ({score.notes.length} notes)
    </div>
  );
}
