/**
 * Pure layout maths for the sheet renderer: how many measures fit on a row,
 * where each system sits vertically, and which system contains a playback beat.
 * No DOM dependency, so it is unit tested directly.
 */

/** Vertical distance between the top of one grand staff system and the next. */
export const SYSTEM_HEIGHT = 204;
/** Distance from the system top to the top line of the treble staff. */
export const TREBLE_TOP_OFFSET = 32;
/** Distance from the treble staff top to the bass staff top. */
export const STAFF_GAP = 96;
/** Height of a 5-line staff (VexFlow default spacing). */
export const STAFF_HEIGHT = 40;
/** Left margin reserved for the grand-staff brace/barline. */
export const LEFT_MARGIN = 30;
/** Right margin after the last measure of a system. */
export const RIGHT_MARGIN = 16;
/** Extra width given to the first measure of a system for clef/key/time signature. */
export const FIRST_MEASURE_EXTRA = 56;
/** Padding below the last system. */
export const BOTTOM_PADDING = 16;
/** Minimum usable width for the renderer. */
export const MIN_WIDTH = 240;

export interface MeasureSpan {
  start: number;
  end: number;
}

export interface SystemLayout {
  /** System index, 0-based. */
  index: number;
  /** First measure index (into the measures array). */
  measureStart: number;
  /** One past the last measure index of this system. */
  measureEnd: number;
  /** Measures in this system. */
  measureCount: number;
  /** Width of the measures after the first, in px. */
  measureWidth: number;
  /** Width of the first measure (includes room for clef/key/time signature). */
  firstMeasureWidth: number;
  /** Top of the system (first staff's top - offsets). */
  top: number;
  /** Height of the system block, in px. */
  height: number;
  /** First beat of the system. */
  startBeat: number;
  /** First beat after the system. */
  endBeat: number;
}

export interface ScoreLayout {
  /** SVG width in px. */
  width: number;
  /** SVG height in px. */
  height: number;
  measuresPerSystem: number;
  systems: SystemLayout[];
  leftMargin: number;
  rightMargin: number;
  /** Vertical offset added above the systems (title/header area). */
  topOffset: number;
}

export interface LayoutOptions {
  /** Force a measures-per-system value (otherwise responsive). */
  measuresPerSystem?: number;
  /** Extra space above the systems (title, headers). */
  topOffset?: number;
  /** Extra space below the systems. */
  bottomPadding?: number;
}

/** Responsive number of measures per system for a given pixel width. */
export function measuresPerSystemForWidth(width: number): number {
  const safe = Number.isFinite(width) ? width : 900;
  if (safe >= 1020) return 4;
  if (safe >= 760) return 3;
  if (safe >= 500) return 2;
  return 1;
}

/**
 * Splits `measures` into systems and computes their geometry. Every system is
 * justified to the full width, so a short final system gets wider measures.
 */
export function buildScoreLayout(
  measures: readonly MeasureSpan[],
  width: number,
  options: LayoutOptions = {},
): ScoreLayout {
  const safeWidth = Math.max(MIN_WIDTH, Math.round(Number.isFinite(width) ? width : 900));
  const topOffset = Math.max(0, options.topOffset ?? 0);
  const bottomPadding = Math.max(0, options.bottomPadding ?? BOTTOM_PADDING);
  const perSystemRaw = options.measuresPerSystem ?? measuresPerSystemForWidth(safeWidth);
  const perSystem = Math.max(1, Math.min(8, Math.floor(perSystemRaw)));

  const available = Math.max(40, safeWidth - LEFT_MARGIN - RIGHT_MARGIN);
  const systems: SystemLayout[] = [];

  for (let measureStart = 0; measureStart < measures.length; measureStart += perSystem) {
    const measureEnd = Math.min(measures.length, measureStart + perSystem);
    const measureCount = measureEnd - measureStart;
    const first = measures[measureStart];
    const last = measures[measureEnd - 1];
    const top = topOffset + systems.length * SYSTEM_HEIGHT;
    let measureWidth = available;
    let firstMeasureWidth = available;
    if (measureCount > 1) {
      const extra = Math.min(FIRST_MEASURE_EXTRA, available * 0.4);
      measureWidth = (available - extra) / measureCount;
      firstMeasureWidth = measureWidth + extra;
    }
    systems.push({
      index: systems.length,
      measureStart,
      measureEnd,
      measureCount,
      measureWidth,
      firstMeasureWidth,
      top,
      height: SYSTEM_HEIGHT,
      startBeat: first ? first.start : 0,
      endBeat: last ? last.end : 0,
    });
  }

  const height = topOffset + systems.length * SYSTEM_HEIGHT + bottomPadding;
  return {
    width: safeWidth,
    height,
    measuresPerSystem: perSystem,
    systems,
    leftMargin: LEFT_MARGIN,
    rightMargin: RIGHT_MARGIN,
    topOffset,
  };
}

/** Index of the system containing `beat` (clamped to the available systems). */
export function systemIndexForBeat(layout: ScoreLayout, beat: number): number {
  const systems = layout.systems;
  if (systems.length === 0) return -1;
  if (!Number.isFinite(beat) || beat <= systems[0].startBeat) return 0;
  for (let i = systems.length - 1; i >= 0; i -= 1) {
    if (beat >= systems[i].startBeat - 1e-6) return i;
  }
  return systems.length - 1;
}

/** Y coordinate of the top line of the treble staff of a system. */
export function trebleY(system: SystemLayout): number {
  return system.top + TREBLE_TOP_OFFSET;
}

/** Y coordinate of the top line of the bass staff of a system. */
export function bassY(system: SystemLayout): number {
  return system.top + TREBLE_TOP_OFFSET + STAFF_GAP;
}

/** X coordinate where the given measure starts inside its system. */
export function measureX(system: SystemLayout, measureOffset: number, leftMargin = LEFT_MARGIN): number {
  if (measureOffset <= 0) return leftMargin;
  return (
    leftMargin +
    system.firstMeasureWidth +
    (measureOffset - 1) * system.measureWidth
  );
}

/** Width of the given measure inside its system. */
export function measureWidthAt(system: SystemLayout, measureOffset: number): number {
  return measureOffset <= 0 ? system.firstMeasureWidth : system.measureWidth;
}
