import { describe, expect, it } from 'vitest';
import {
  BOTTOM_PADDING,
  FIRST_MEASURE_EXTRA,
  LEFT_MARGIN,
  MIN_WIDTH,
  RIGHT_MARGIN,
  STAFF_GAP,
  SYSTEM_HEIGHT,
  TREBLE_TOP_OFFSET,
  bassY,
  buildScoreLayout,
  measureWidthAt,
  measureX,
  measuresPerSystemForWidth,
  systemIndexForBeat,
  trebleY,
} from './layout';

function spans(count: number, length = 4): { start: number; end: number }[] {
  return Array.from({ length: count }, (_, index) => ({ start: index * length, end: (index + 1) * length }));
}

describe('measuresPerSystemForWidth', () => {
  it('is responsive', () => {
    expect(measuresPerSystemForWidth(1400)).toBe(4);
    expect(measuresPerSystemForWidth(1020)).toBe(4);
    expect(measuresPerSystemForWidth(900)).toBe(3);
    expect(measuresPerSystemForWidth(760)).toBe(3);
    expect(measuresPerSystemForWidth(620)).toBe(2);
    expect(measuresPerSystemForWidth(430)).toBe(1);
    expect(measuresPerSystemForWidth(Number.NaN)).toBe(3);
  });
});

describe('buildScoreLayout', () => {
  it('groups measures into systems of four for wide layouts', () => {
    const layout = buildScoreLayout(spans(10), 1200);
    expect(layout.measuresPerSystem).toBe(4);
    expect(layout.systems.map((system) => system.measureCount)).toEqual([4, 4, 2]);
    expect(layout.systems.map((system) => [system.measureStart, system.measureEnd])).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect(layout.systems.map((system) => system.top)).toEqual([0, SYSTEM_HEIGHT, SYSTEM_HEIGHT * 2]);
    expect(layout.systems[0]?.startBeat).toBe(0);
    expect(layout.systems[1]?.startBeat).toBe(16);
    expect(layout.systems[2]?.endBeat).toBe(40);
    expect(layout.height).toBe(SYSTEM_HEIGHT * 3 + BOTTOM_PADDING + 0);
  });

  it('justifies the final short system to the full width', () => {
    const layout = buildScoreLayout(spans(6), 1200);
    const [first, second] = layout.systems;
    expect(first?.measureCount).toBe(4);
    expect(second?.measureCount).toBe(2);
    const available = 1200 - LEFT_MARGIN - RIGHT_MARGIN;
    const extra = Math.min(FIRST_MEASURE_EXTRA, available * 0.4);
    expect(first?.measureWidth).toBeCloseTo((available - extra) / 4, 6);
    expect(first?.firstMeasureWidth).toBeCloseTo((available - extra) / 4 + extra, 6);
    expect(second?.firstMeasureWidth).toBeCloseTo((available - extra) / 2 + extra, 6);
    // Every system exactly fills the available width.
    for (const system of layout.systems) {
      const total =
        system.firstMeasureWidth + (system.measureCount - 1) * system.measureWidth;
      expect(total).toBeCloseTo(available, 6);
    }
  });

  it('gives the first measure extra room for clef/key/time-signature', () => {
    const layout = buildScoreLayout(spans(4), 1200);
    const system = layout.systems[0];
    expect(system).toBeDefined();
    if (!system || system.measureCount < 2) return;
    expect(system.firstMeasureWidth).toBeGreaterThan(system.measureWidth);
    expect(measureWidthAt(system, 0)).toBe(system.firstMeasureWidth);
    expect(measureWidthAt(system, 1)).toBe(system.measureWidth);
    expect(measureX(system, 1)).toBeCloseTo(LEFT_MARGIN + system.firstMeasureWidth, 6);
    expect(measureX(system, 2)).toBeCloseTo(
      LEFT_MARGIN + system.firstMeasureWidth + system.measureWidth,
      6,
    );
  });

  it('honours explicit measures-per-system and extra offsets', () => {
    const layout = buildScoreLayout(spans(5), 800, { measuresPerSystem: 2, topOffset: 60, bottomPadding: 20 });
    expect(layout.measuresPerSystem).toBe(2);
    expect(layout.systems.map((system) => system.measureCount)).toEqual([2, 2, 1]);
    expect(layout.systems[0]?.top).toBe(60);
    expect(layout.height).toBe(60 + SYSTEM_HEIGHT * 3 + 20);
  });

  it('never goes below the minimum width and handles empty scores', () => {
    const narrow = buildScoreLayout(spans(2), 10);
    expect(narrow.width).toBe(MIN_WIDTH);
    expect(narrow.measuresPerSystem).toBe(1);
    const empty = buildScoreLayout([], 900);
    expect(empty.systems).toEqual([]);
    expect(empty.height).toBe(BOTTOM_PADDING);
  });

  it('keeps system geometry usable', () => {
    const layout = buildScoreLayout(spans(8), 900);
    const system = layout.systems[1];
    expect(system).toBeDefined();
    if (!system) return;
    expect(trebleY(system)).toBe(system.top + TREBLE_TOP_OFFSET);
    expect(bassY(system)).toBe(system.top + TREBLE_TOP_OFFSET + STAFF_GAP);
    expect(bassY(system) + 40).toBeLessThanOrEqual(system.top + SYSTEM_HEIGHT);
    expect(measureX(system, 0)).toBe(LEFT_MARGIN);
    expect(measureX(system, 2)).toBeCloseTo(
      LEFT_MARGIN + system.firstMeasureWidth + system.measureWidth,
      6,
    );
  });
});

describe('systemIndexForBeat', () => {
  const layout = buildScoreLayout(spans(10), 1200);

  it('finds the system for a beat', () => {
    expect(systemIndexForBeat(layout, 0)).toBe(0);
    expect(systemIndexForBeat(layout, 15.9)).toBe(0);
    expect(systemIndexForBeat(layout, 16)).toBe(1);
    expect(systemIndexForBeat(layout, 33)).toBe(2);
    expect(systemIndexForBeat(layout, 9999)).toBe(2);
    expect(systemIndexForBeat(layout, Number.NaN)).toBe(0);
  });

  it('returns -1 when there are no systems', () => {
    expect(systemIndexForBeat(buildScoreLayout([], 900), 0)).toBe(-1);
  });
});
