import { useEffect, useRef } from 'react';
import type { PianoEngine } from '../audio/PianoEngine';

/** Tiny live output-level meter (reads the engine's master analyser). */
export function SoundMeter({ engine, className }: { engine: PianoEngine; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let frame = 0;
    const smoothed = [0, 0, 0, 0, 0];

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const host = ref.current;
      if (!host) return;
      const level = engine.getOutputLevel();
      const bars = host.children;
      for (let index = 0; index < bars.length; index += 1) {
        const target = Math.min(1, level * (0.72 + index * 0.14));
        smoothed[index] = smoothed[index] * 0.68 + target * 0.32;
        const bar = bars[index] as HTMLElement;
        bar.style.height = `${14 + smoothed[index] * 86}%`;
        bar.style.opacity = `${0.3 + smoothed[index] * 0.7}`;
      }
      host.classList.toggle('live', level > 0.015);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engine]);

  return (
    <div ref={ref} className={`sound-meter ${className ?? ''}`} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
