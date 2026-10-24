import { useEffect, useMemo, useRef } from 'react';
import type { Score } from '../music/types';
import type { PlaybackPosition } from '../hooks/usePlayback';
import { beatToSeconds, buildMeasures, measureBeats, secondsToBeat, timeSignatureAt } from '../music/timing';
import { isBlackKey, midiToName } from '../music/pitch';

export interface PianoRollLayout {
  minMidi: number;
  maxMidi: number;
  laneWidth: number;
  hitLineY: number;
  keyStripTop: number;
  pxPerSec: number;
}

export function pitchRange(score: Score): { minMidi: number; maxMidi: number } {
  if (!score.notes.length) return { minMidi: 48, maxMidi: 72 };
  let min = 127;
  let max = 0;
  for (const note of score.notes) {
    if (note.midi < min) min = note.midi;
    if (note.midi > max) max = note.midi;
  }
  min -= 2;
  max += 2;
  const minSpan = 28;
  const span = max - min + 1;
  if (span < minSpan) {
    const pad = Math.ceil((minSpan - span) / 2);
    min -= pad;
    max += pad;
  }
  min = Math.max(21, min);
  max = Math.min(108, max);
  if (max - min < 11) {
    if (min === 21) max = min + 11;
    else min = max - 11;
  }
  return { minMidi: min, maxMidi: max };
}

export function pianoRollLayout(width: number, height: number, score: Score): PianoRollLayout {
  const { minMidi, maxMidi } = pitchRange(score);
  const { laneWidth, keyStripTop, hitLineY } = {
    laneWidth: width / (maxMidi - minMidi + 1),
    keyStripTop: Math.max(120, height - 38),
    hitLineY: Math.max(100, height - 52),
  };
  const pxPerSec = Math.max(40, hitLineY / 4.4);
  return { minMidi, maxMidi, laneWidth, hitLineY, keyStripTop, pxPerSec };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

interface TimedNote {
  midi: number;
  startSec: number;
  durationSec: number;
  hand: 'left' | 'right';
}

export interface PianoRollProps {
  score: Score;
  getPosition: () => PlaybackPosition;
  isPlaying: boolean;
  onSeek?: (beat: number) => void;
  className?: string;
}

/** Fallen-notes piano roll with a live keyboard strip and click-to-seek. */
export function PianoRoll({ score, getPosition, isPlaying, onSeek, className }: PianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });

  const timedNotes = useMemo<TimedNote[]>(() => {
    return score.notes
      .map((note) => ({
        midi: note.midi,
        startSec: beatToSeconds(score, note.start),
        durationSec: Math.max(
          0.03,
          beatToSeconds(score, note.start + note.duration) - beatToSeconds(score, note.start),
        ),
        hand: note.hand,
      }))
      .sort((a, b) => a.startSec - b.startSec);
  }, [score]);

  const measures = useMemo(() => buildMeasures(score, 4000), [score]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { width: rect.width, height: rect.height, dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      const { width, height, dpr } = sizeRef.current;
      if (!width || !height) return;
      const view = pianoRollLayout(width, height, score);
      const position = getPosition();
      const nowSec = position.scoreSec;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#0a0d13';
      ctx.fillRect(0, 0, width, height);

      const laneW = view.laneWidth;
      const stripTop = view.keyStripTop;
      const hitY = view.hitLineY;
      const pxPerSec = view.pxPerSec;

      // Pitch lanes
      for (let midi = view.minMidi; midi <= view.maxMidi; midi += 1) {
        const x = (midi - view.minMidi) * laneW;
        ctx.fillStyle = isBlackKey(midi) ? '#0d1119' : '#131922';
        ctx.fillRect(x, 0, laneW, stripTop);
        ctx.strokeStyle = 'rgba(255,255,255,0.025)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, 0, laneW, stripTop);
      }

      // C labels down the left edge of each octave lane
      ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = 'rgba(141,153,173,0.7)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let midi = view.minMidi; midi <= view.maxMidi; midi += 1) {
        if (midi % 12 === 0 && laneW >= 6) {
          const x = (midi - view.minMidi) * laneW + 2;
          ctx.fillText(midiToName(midi), x, 6);
        }
      }

      const visibleStartSec = nowSec - stripTop / pxPerSec;
      const visibleEndSec = nowSec + hitY / pxPerSec;

      // Beat grid
      const startBeat = Math.max(0, secondsToBeat(score, visibleStartSec));
      const endBeat = Math.min(score.lengthBeats + 4, secondsToBeat(score, visibleEndSec));
      ctx.strokeStyle = 'rgba(38,48,63,0.55)';
      ctx.lineWidth = 1;
      for (let beat = Math.ceil(startBeat); beat <= endBeat; beat += 1) {
        const sec = beatToSeconds(score, beat);
        const y = hitY - (sec - nowSec) * pxPerSec;
        if (y < 0 || y > stripTop) continue;
        const signature = timeSignatureAt(score, beat);
        const bar = measureBeats(signature);
        const isBar = Math.abs(((beat % bar) + bar) % bar) < 1e-6;
        ctx.strokeStyle = isBar ? 'rgba(54,68,90,0.85)' : 'rgba(38,48,63,0.42)';
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
        ctx.stroke();
      }

      // Bar numbers on the right edge
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(141,153,173,0.55)';
      for (const measure of measures) {
        const sec = beatToSeconds(score, measure.start);
        if (sec < visibleStartSec || sec > visibleEndSec) continue;
        const y = hitY - (sec - nowSec) * pxPerSec;
        if (y < 12 || y > stripTop - 4) continue;
        ctx.fillText(`${measure.index + 1}`, width - 6, y - 12);
      }

      const active = new Set<number>();

      // Notes
      for (const note of timedNotes) {
        const y = hitY - (note.startSec - nowSec) * pxPerSec;
        const heightPx = Math.max(6, note.durationSec * pxPerSec);
        if (y + heightPx < 0 || y > stripTop) continue;
        const x = (note.midi - view.minMidi) * laneW + 1.5;
        const noteWidth = Math.max(2, laneW - 3);
        const sounding = note.startSec <= nowSec && note.startSec + note.durationSec > nowSec;
        if (sounding) active.add(note.midi);

        ctx.save();
        if (sounding) {
          ctx.shadowColor = note.hand === 'left' ? '#63b3ed' : '#e0b64c';
          ctx.shadowBlur = 14;
        }
        const gradient = ctx.createLinearGradient(x, y, x + noteWidth, y);
        if (note.hand === 'left') {
          gradient.addColorStop(0, sounding ? '#9bd3ff' : '#4a9fd4');
          gradient.addColorStop(1, sounding ? '#5aa9e6' : '#2d6f9e');
        } else {
          gradient.addColorStop(0, sounding ? '#ffe08a' : '#d8b25a');
          gradient.addColorStop(1, sounding ? '#e2b64d' : '#a9822f');
        }
        ctx.fillStyle = gradient;
        const drawY = Math.max(-20, y);
        roundRect(ctx, x, drawY, noteWidth, Math.max(4, heightPx), Math.min(4, noteWidth / 3));
        ctx.fill();
        ctx.restore();
      }

      // Hit line
      ctx.save();
      ctx.strokeStyle = 'rgba(224,182,76,0.9)';
      ctx.shadowColor = 'rgba(224,182,76,0.8)';
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, hitY + 0.5);
      ctx.lineTo(width, hitY + 0.5);
      ctx.stroke();
      ctx.restore();

      // Bottom key strip
      ctx.fillStyle = '#0b0e14';
      ctx.fillRect(0, stripTop, width, height - stripTop);
      for (let midi = view.minMidi; midi <= view.maxMidi; midi += 1) {
        const x = (midi - view.minMidi) * laneW;
        const black = isBlackKey(midi);
        ctx.fillStyle = active.has(midi) ? '#ffd166' : black ? '#1a1e26' : '#e9e2d2';
        if (black) {
          ctx.fillRect(x + laneW * 0.16, stripTop, laneW * 0.68, (height - stripTop) * 0.68);
        } else {
          ctx.fillRect(x, stripTop, laneW, height - stripTop);
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, stripTop + 0.5, laneW - 1, height - stripTop - 1);
      }

      // Top status
      ctx.textAlign = 'left';
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(141,153,173,0.9)';
      ctx.fillText(isPlaying ? '● PLAYING' : '❚❚ PAUSED', 10, 22);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [score, timedNotes, measures, getPosition, isPlaying]);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onSeek) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const view = pianoRollLayout(rect.width, rect.height, score);
    const y = event.clientY - rect.top;
    const position = getPosition();
    const targetSec = position.scoreSec + (view.hitLineY - y) / view.pxPerSec;
    const targetBeat = secondsToBeat(score, Math.max(0, targetSec));
    onSeek(Math.min(score.lengthBeats, Math.max(0, targetBeat)));
  };

  return (
    <div ref={wrapRef} className={`piano-roll ${className ?? ''}`}>
      <canvas
        ref={canvasRef}
        className="piano-roll-canvas"
        onPointerDown={handlePointerDown}
        style={{ cursor: onSeek ? 'crosshair' : 'default' }}
        aria-label="Falling-note piano roll; click to seek"
        role="img"
      />
      <div className="piano-roll-legend">
        <span className="legend-dot right" /> Right hand
        <span className="legend-dot left" /> Left hand
        <span className="legend-hint">Click anywhere to seek</span>
      </div>
    </div>
  );
}
