/**
 * Sheet-music view: a VexFlow grand staff with playback highlighting and
 * click-to-seek, laid out in responsive systems inside a scroll container.
 *
 * Public API is fixed by CONTRACT.md §3.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Score } from '../music/types';
import { buildMeasures } from '../music/timing';
import { MAX_TOTAL_MEASURES, activeNoteIds } from './notation';
import { renderScoreInto, type RenderResult } from './renderer';
import { systemIndexForBeat } from './layout';
import './SheetView.css';

// Re-export the standalone SVG export from the component module, as required
// by the integration contract.
export { renderScoreSvg } from './renderer';

export interface SheetViewProps {
  score: Score;
  /** Playback position in quarter-note beats (drives highlighting + follow). */
  currentBeat?: number;
  /** Currently sounding MIDI notes -> highlight matching noteheads. */
  activeMidis?: number[];
  /** Auto-scroll to the system containing `currentBeat` (default true). */
  follow?: boolean;
  /** Clicking a measure calls this with the measure's first beat. */
  onSeek?: (beat: number) => void;
  className?: string;
}

/** Measures rendered on the first pass; more are appended when scrolled. */
const INITIAL_MEASURES = 96;
/** Measures appended per "show more"/auto-extension step. */
const EXTEND_STEP = 96;
/** Absolute cap on rendered measures for responsiveness. */
const HARD_CAP = 400;
/** Duration of the follow auto-scroll animation, in ms. */
const SCROLL_MS = 260;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * rAF-driven smooth scroll. Kept local (instead of `behavior: smooth`) so the
 * animation also runs in environments where the browser's native smooth scroll
 * is unavailable (e.g. headless/automated browsers).
 */
function animateScrollTo(element: HTMLElement, top: number, handle: { current: number }): void {
  if (handle.current) cancelAnimationFrame(handle.current);
  const start = element.scrollTop;
  const delta = top - start;
  if (Math.abs(delta) < 1 || prefersReducedMotion()) {
    element.scrollTop = top;
    return;
  }
  const startTime = performance.now();
  const step = (now: number): void => {
    const progress = Math.min(1, Math.max(0, (now - startTime) / SCROLL_MS));
    const eased = 1 - Math.pow(1 - progress, 3);
    element.scrollTop = start + delta * eased;
    handle.current = progress < 1 ? requestAnimationFrame(step) : 0;
  };
  handle.current = requestAnimationFrame(step);
}

export function SheetView({
  score,
  currentBeat = 0,
  activeMidis,
  follow = true,
  onSeek,
  className,
}: SheetViewProps): ReactElement | null {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const renderRef = useRef<RenderResult | null>(null);
  const appliedHighlightRef = useRef<Set<string>>(new Set());
  const followSystemRef = useRef(-1);
  const canExtendRef = useRef(false);
  const extendLockRef = useRef(false);
  const scrollAnimRef = useRef(0);
  const currentBeatRef = useRef(currentBeat);
  const activeMidisRef = useRef<number[] | undefined>(activeMidis);
  const onSeekRef = useRef(onSeek);
  const followRef = useRef(follow);
  const previousScoreRef = useRef(score);

  const [width, setWidth] = useState(0);
  const [measureLimit, setMeasureLimit] = useState(INITIAL_MEASURES);
  const [error, setError] = useState<string | null>(null);

  currentBeatRef.current = currentBeat;
  activeMidisRef.current = activeMidis;
  onSeekRef.current = onSeek;
  followRef.current = follow;

  const totalMeasures = useMemo(() => buildMeasures(score, MAX_TOTAL_MEASURES).length, [score]);
  const renderedLimit = Math.min(HARD_CAP, Math.max(1, measureLimit));
  const hasMore = totalMeasures > renderedLimit && renderedLimit < HARD_CAP;

  // Fresh score -> start from the initial (responsive) measure cap again.
  useEffect(() => {
    setMeasureLimit(INITIAL_MEASURES);
    followSystemRef.current = -1;
    appliedHighlightRef.current = new Set();
  }, [score]);

  // Track the available width of the scroll container.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    const measure = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = Math.round(scroll.clientWidth - 12);
        if (next < 120) return;
        setWidth((previous) => (Math.abs(previous - next) >= 2 ? next : previous));
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (frame) cancelAnimationFrame(frame);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // Cancel any in-flight follow animation when the view unmounts.
  useEffect(
    () => () => {
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = 0;
    },
    [],
  );

  const applyHighlight = useCallback((): void => {
    const result = renderRef.current;
    if (!result) return;
    const nextIds = new Set(
      activeNoteIds(result.model.highlight, currentBeatRef.current, activeMidisRef.current),
    );
    const previous = appliedHighlightRef.current;
    const elements = result.noteElements;

    for (const noteId of previous) {
      if (nextIds.has(noteId)) continue;
      const groups = elements.get(noteId);
      if (!groups) continue;
      for (const group of groups) group.classList.remove('is-sounding');
    }
    for (const noteId of nextIds) {
      if (previous.has(noteId)) continue;
      const groups = elements.get(noteId);
      if (!groups) continue;
      for (const group of groups) group.classList.add('is-sounding');
    }
    appliedHighlightRef.current = nextIds;
  }, []);

  const scrollToBeat = useCallback((beat: number, smooth: boolean): void => {
    const result = renderRef.current;
    const scroll = scrollRef.current;
    if (!result || !scroll || result.layout.systems.length === 0) return;
    if (!Number.isFinite(beat)) return;
    const index = systemIndexForBeat(result.layout, beat);
    if (index < 0 || index === followSystemRef.current) return;
    const system = result.layout.systems[index];
    if (!system) return;
    followSystemRef.current = index;
    const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const top = Math.max(0, Math.min(maxScroll, system.top - 8));
    if (smooth) animateScrollTo(scroll, top, scrollAnimRef);
    else {
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = 0;
      scroll.scrollTop = top;
    }
  }, []);

  const requestMore = useCallback((): void => {
    setMeasureLimit((limit) => {
      const current = Math.min(HARD_CAP, Math.max(1, limit));
      if (current >= HARD_CAP) return current;
      return Math.min(HARD_CAP, current + EXTEND_STEP);
    });
  }, []);

  // Main render: score / width / measure cap change -> rebuild the SVG.
  useLayoutEffect(() => {
    if (width <= 0) return;
    const host = hostRef.current;
    if (!host) return;
    const scroll = scrollRef.current;
    const previousTop = scroll ? scroll.scrollTop : 0;
    const scoreChanged = previousScoreRef.current !== score;
    previousScoreRef.current = score;
    let failed = false;
    try {
      const result = renderScoreInto(host, score, {
        width,
        maxMeasures: renderedLimit,
        theme: 'screen',
      });
      renderRef.current = result;
      canExtendRef.current =
        result.model.renderedMeasures < result.model.totalMeasures &&
        result.model.renderedMeasures < HARD_CAP;
      setError(null);
    } catch (renderError) {
      failed = true;
      renderRef.current = null;
      canExtendRef.current = false;
      setError(renderError instanceof Error ? renderError.message : 'Unable to render this score');
    }

    const svg = host.querySelector('svg');
    const handleClick = (event: MouseEvent): void => {
      const seek = onSeekRef.current;
      if (!seek) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const hit = target.closest('[data-beat]');
      if (!hit) return;
      const raw = hit.getAttribute('data-beat');
      if (raw === null) return;
      const beat = Number(raw);
      if (Number.isFinite(beat)) seek(beat);
    };
    if (!failed) svg?.addEventListener('click', handleClick);

    appliedHighlightRef.current = new Set();
    followSystemRef.current = -1;
    if (!failed) {
      applyHighlight();
      if (scroll) {
        if (followRef.current) {
          scrollToBeat(currentBeatRef.current, false);
        } else if (scoreChanged) {
          scroll.scrollTop = 0;
        } else {
          // Keep the user's place when more measures are appended.
          const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
          scroll.scrollTop = Math.min(previousTop, maxScroll);
        }
      }
    }

    return () => {
      if (svg) svg.removeEventListener('click', handleClick);
      host.innerHTML = '';
      renderRef.current = null;
      appliedHighlightRef.current = new Set();
    };
  }, [score, width, renderedLimit, applyHighlight, scrollToBeat]);

  // Highlight playback positions without re-rendering the score.
  useLayoutEffect(() => {
    applyHighlight();
  }, [currentBeat, activeMidis, applyHighlight]);

  // Follow the active system as playback advances.
  useEffect(() => {
    if (!follow) return;
    const result = renderRef.current;
    if (!result) return;
    const systems = result.layout.systems;
    const last = systems[systems.length - 1];
    if (last && Number.isFinite(currentBeat) && currentBeat >= last.endBeat - 1e-6) {
      if (canExtendRef.current) {
        requestMore();
        return;
      }
    }
    scrollToBeat(currentBeat, true);
  }, [currentBeat, follow, requestMore, scrollToBeat]);

  // Turning follow back on jumps to the active system immediately.
  useEffect(() => {
    if (!follow) return;
    followSystemRef.current = -1;
    scrollToBeat(currentBeatRef.current, true);
  }, [follow, scrollToBeat]);

  // Auto-append measures when the user scrolls near the bottom.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onScroll = (): void => {
      if (!canExtendRef.current || extendLockRef.current) return;
      if (scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 700) return;
      extendLockRef.current = true;
      requestMore();
      window.setTimeout(() => {
        extendLockRef.current = false;
      }, 300);
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => scroll.removeEventListener('scroll', onScroll);
  }, [requestMore]);

  const title = (score.title ?? '').trim();
  const composer = (score.composer ?? '').trim();

  return (
    <section
      className={['piano-sheet', className].filter(Boolean).join(' ')}
      aria-label={title ? `Sheet music: ${title}` : 'Sheet music'}
    >
      {(title || composer) && (
        <header className="piano-sheet__head">
          {title && <h2 className="piano-sheet__title">{title}</h2>}
          {composer && <p className="piano-sheet__composer">{composer}</p>}
          <span className="piano-sheet__meta">
            {totalMeasures} {totalMeasures === 1 ? 'measure' : 'measures'}
            {totalMeasures > renderedLimit ? ` · showing first ${renderedLimit}` : ''}
          </span>
        </header>
      )}
      <div className="piano-sheet__scroll" ref={scrollRef}>
        <div className="piano-sheet__stage" ref={hostRef} />
        {error && <p className="piano-sheet__error">Could not render this score: {error}</p>}
        {hasMore && (
          <button type="button" className="piano-sheet__more" onClick={requestMore}>
            Show more measures…
          </button>
        )}
      </div>
    </section>
  );
}
