/**
 * VexFlow grand-staff renderer.
 *
 * Renders the pure display model from `notation.ts` into a VexFlow SVG inside a
 * host element. Used both by the React component (screen theme, highlighting,
 * click-to-seek) and by `renderScoreSvg` (standalone, print-friendly export).
 */
import {
  Accidental,
  Barline,
  Beam,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Stem,
  Voice,
} from 'vexflow';
import type { Score } from '../music/types';
import {
  buildDisplayModel,
  timeSignatureSpec,
  type DisplayMeasure,
  type DisplayModel,
  type MeasureEvent,
  type StaffId,
  type VoiceNumber,
} from './notation';
import {
  LEFT_MARGIN,
  RIGHT_MARGIN,
  bassY,
  buildScoreLayout,
  measureX,
  measureWidthAt,
  trebleY,
  type ScoreLayout,
  type SystemLayout,
} from './layout';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface RenderScoreOptions {
  /** Pixel width available for the score. */
  width: number;
  /** Maximum number of measures to render (default 400). */
  maxMeasures?: number;
  /** `screen` relies on CSS for ink colours; `export` uses VexFlow's black ink. */
  theme?: 'screen' | 'export';
  /** Extra vertical space above the systems (title area). */
  topOffset?: number;
  /** Optional title/subtitle drawn inside the SVG (export). */
  title?: string;
  subtitle?: string;
}

export interface RenderResult {
  model: DisplayModel;
  layout: ScoreLayout;
  /** Source note id -> rendered note groups (more than one for tied segments). */
  noteElements: Map<string, SVGGElement[]>;
  /** The rendered SVG root (null when VexFlow failed to create one). */
  svg: SVGSVGElement | null;
}

interface NoteRecord {
  /** VexFlow element id (prefixed with `vf-` in the SVG). */
  svgId: string;
  /** Source note ids in this chord. */
  sourceIds: string[];
}

interface VoiceGroup {
  number: VoiceNumber;
  voice: Voice;
  tickables: StaveNote[];
  events: MeasureEvent[];
  stemDirection: number | null;
}

type StaveNoteParams = ConstructorParameters<typeof StaveNote>[0];

let elementSeed = 0;

function nextElementId(): string {
  elementSeed += 1;
  return `sheet-note-${elementSeed}`;
}

function safeSvgRect(
  svg: SVGSVGElement | null,
  x: number,
  y: number,
  width: number,
  height: number,
  className: string,
  beat: number,
): void {
  if (!svg || width <= 0 || height <= 0) return;
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', x.toFixed(2));
  rect.setAttribute('y', y.toFixed(2));
  rect.setAttribute('width', width.toFixed(2));
  rect.setAttribute('height', height.toFixed(2));
  rect.setAttribute('class', className);
  rect.setAttribute('data-beat', String(beat));
  rect.setAttribute('fill', 'transparent');
  svg.appendChild(rect);
}

function createStaveNote(
  event: MeasureEvent,
  clef: StaffId,
  stemDirection: number | null,
  svgId: string,
): StaveNote {
  const params: StaveNoteParams = {
    keys: event.keys.map((key) => key.key),
    duration: event.duration,
    auto_stem: true,
    clef,
  };
  if (event.dots > 0) params.dots = event.dots;
  if (event.kind === 'rest') {
    params.type = 'r';
  } else if (stemDirection !== null) {
    params.auto_stem = false;
    params.stem_direction = stemDirection;
  }
  const note = new StaveNote(params);
  if (event.dots > 0) Dot.buildAndAttach([note], { all: true });
  note.setAttribute('id', svgId);
  return note;
}

/** Builds the voices of one staff of one measure, formats them onto `stave`. */
function drawStaffMeasure(
  stave: Stave,
  measure: DisplayMeasure,
  staff: StaffId,
  clef: StaffId,
  keySpec: string,
  ctx: ReturnType<Renderer['getContext']>,
  records: NoteRecord[],
  tiesToDraw: StaveTie[],
  pendingTies: Map<string, { note: StaveNote; endBeat: number; keyCount: number }>,
): void {
  const eventsByVoice = new Map<VoiceNumber, MeasureEvent[]>();
  for (const event of measure.events[staff]) {
    const list = eventsByVoice.get(event.voice);
    if (list) list.push(event);
    else eventsByVoice.set(event.voice, [event]);
  }
  if (eventsByVoice.size === 0) return;

  const voiceNumbers = [...eventsByVoice.keys()].sort((a, b) => a - b);
  const twoVoices = voiceNumbers.length > 1;
  const groups: VoiceGroup[] = [];

  for (const voiceNumber of voiceNumbers) {
    const events = [...(eventsByVoice.get(voiceNumber) ?? [])].sort((a, b) => a.offset - b.offset);
    const stemDirection = twoVoices ? (voiceNumber === 1 ? Stem.UP : Stem.DOWN) : null;
    const tickables: StaveNote[] = [];
    for (const event of events) {
      const svgId = nextElementId();
      const note = createStaveNote(event, clef, stemDirection, svgId);
      tickables.push(note);
      if (event.kind === 'note' && event.noteIds.length > 0) {
        records.push({ svgId, sourceIds: event.noteIds });
      }
    }
    const voice = new Voice({ num_beats: measure.beats, beat_value: 4 });
    voice.setStrict(false);
    voice.addTickables(tickables);
    groups.push({ number: voiceNumber, voice, tickables, events, stemDirection });
  }

  // Accidentals are derived from the key signature, then formatting places them.
  Accidental.applyAccidentals(
    groups.map((group) => group.voice),
    keySpec,
  );

  const formatter = new Formatter();
  for (const group of groups) formatter.joinVoices([group.voice]);
  formatter.formatToStave(
    groups.map((group) => group.voice),
    stave,
    { align_rests: true },
  );

  const beamGroups = Beam.getDefaultBeamGroups(timeSignatureSpec(measure.timeSignature));
  const beams = groups.map((group) =>
    Beam.generateBeams(group.tickables, {
      groups: beamGroups,
      maintain_stem_directions: group.stemDirection !== null,
      ...(group.stemDirection !== null ? { stem_direction: group.stemDirection } : {}),
    }),
  );

  for (const group of groups) {
    group.voice.setStave(stave);
    group.voice.draw(ctx, stave);
  }
  for (const groupBeams of beams) {
    for (const beam of groupBeams) beam.setContext(ctx).draw();
  }

  // Ties between consecutive segments of the same source note (within a system).
  for (const group of groups) {
    for (const [index, event] of group.events.entries()) {
      if (event.kind !== 'note' || !event.tieGroup) continue;
      const note = group.tickables[index];
      if (!note) continue;
      const startBeat = measure.start + event.offset;
      const endBeat = startBeat + event.beats;
      const previous = pendingTies.get(event.tieGroup);
      if (
        previous &&
        Math.abs(previous.endBeat - startBeat) < 1e-6 &&
        previous.note !== note
      ) {
        const keyCount = Math.min(previous.keyCount, event.keys.length);
        const indices = Array.from({ length: keyCount }, (_, keyIndex) => keyIndex);
        tiesToDraw.push(
          new StaveTie({
            first_note: previous.note,
            last_note: note,
            first_indices: indices,
            last_indices: indices,
          }),
        );
      }
      pendingTies.set(event.tieGroup, { note, endBeat, keyCount: event.keys.length });
    }
  }
}

function drawSystems(
  ctx: ReturnType<Renderer['getContext']>,
  svg: SVGSVGElement | null,
  model: DisplayModel,
  layout: ScoreLayout,
  options: RenderScoreOptions,
): NoteRecord[] {
  const records: NoteRecord[] = [];
  const keySpec = model.keySpec;
  const lastMeasureIndex = model.measures.length - 1;

  for (const system of layout.systems) {
    const systemMeasures = model.measures.slice(system.measureStart, system.measureEnd);
    const trebleTop = trebleY(system);
    const bassTop = bassY(system);
    const pendingTies = new Map<string, { note: StaveNote; endBeat: number; keyCount: number }>();

    for (const [offsetInSystem, measure] of systemMeasures.entries()) {
      const measurePosition = system.measureStart + offsetInSystem;
      const isSystemStart = offsetInSystem === 0;
      const isFinalMeasure = measurePosition === lastMeasureIndex;
      const x = measureX(system, offsetInSystem);
      const width = measureWidthAt(system, offsetInSystem);

      const trebleStave = new Stave(x, trebleTop, width, {
        left_bar: isSystemStart,
        right_bar: true,
      });
      const bassStave = new Stave(x, bassTop, width, {
        left_bar: isSystemStart,
        right_bar: true,
      });

      for (const [staff, stave] of [
        ['treble', trebleStave],
        ['bass', bassStave],
      ] as const) {
        if (isSystemStart) {
          stave.addClef(staff);
          stave.addKeySignature(keySpec);
          stave.addTimeSignature(timeSignatureSpec(measure.timeSignature));
          stave.setMeasure(measure.index + 1);
        } else if (measure.timeSignatureChanged) {
          stave.addTimeSignature(timeSignatureSpec(measure.timeSignature));
        }
        if (isFinalMeasure) stave.setEndBarType(Barline.type.END);
        stave.setContext(ctx).draw();
      }

      try {
        const tiesToDraw: StaveTie[] = [];
        drawStaffMeasure(
          trebleStave,
          measure,
          'treble',
          'treble',
          keySpec,
          ctx,
          records,
          tiesToDraw,
          pendingTies,
        );
        drawStaffMeasure(
          bassStave,
          measure,
          'bass',
          'bass',
          keySpec,
          ctx,
          records,
          tiesToDraw,
          pendingTies,
        );
        for (const tie of tiesToDraw) tie.setContext(ctx).draw();
      } catch (error) {
        // One malformed measure must not take the whole score down.
        console.warn('[SheetView] failed to render measure', measure.index, error);
      }

      if (isSystemStart) {
        const brace = new StaveConnector(trebleStave, bassStave).setType('brace');
        brace.setContext(ctx).draw();
        const line = new StaveConnector(trebleStave, bassStave).setType('singleLeft');
        line.setContext(ctx).draw();
      }

      if (options.theme !== 'export') {
        safeSvgRect(
          svg,
          x,
          system.top + 4,
          Math.max(1, width - 1),
          system.height - 8,
          'piano-sheet__hit',
          measure.start,
        );
      }
    }
  }

  return records;
}

function resolveNoteElements(
  svg: SVGSVGElement | null,
  records: readonly NoteRecord[],
): Map<string, SVGGElement[]> {
  const map = new Map<string, SVGGElement[]>();
  if (!svg) return map;
  const byId = new Map<string, SVGGElement>();
  for (const element of Array.from(svg.querySelectorAll<SVGGElement>('g.vf-stavenote'))) {
    const id = element.getAttribute('id');
    if (id) byId.set(id, element);
  }
  for (const record of records) {
    const element = byId.get(`vf-${record.svgId}`);
    if (!element) continue;
    for (const sourceId of record.sourceIds) {
      const list = map.get(sourceId);
      if (list) list.push(element);
      else map.set(sourceId, [element]);
    }
  }
  return map;
}

function addText(
  svg: SVGSVGElement,
  x: number,
  y: number,
  text: string,
  size: number,
  fill: string,
): void {
  const node = document.createElementNS(SVG_NS, 'text');
  node.setAttribute('x', x.toFixed(2));
  node.setAttribute('y', y.toFixed(2));
  node.setAttribute('font-family', "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif");
  node.setAttribute('font-size', String(size));
  node.setAttribute('fill', fill);
  node.textContent = text;
  svg.appendChild(node);
}

/**
 * Renders a score into `host`, replacing any existing content.
 * The returned `noteElements` map is used by the component for highlighting.
 */
export function renderScoreInto(
  host: HTMLDivElement,
  score: Score,
  options: RenderScoreOptions,
): RenderResult {
  host.innerHTML = '';
  const width = Math.max(
    240,
    Math.round(Number.isFinite(options.width) ? options.width : 900),
  );
  const theme = options.theme ?? 'screen';
  const title = (options.title ?? '').trim();
  const subtitle = (options.subtitle ?? '').trim();
  const topOffset = Math.max(0, options.topOffset ?? (title || subtitle ? 64 : 0));

  const model = buildDisplayModel(score, { maxMeasures: options.maxMeasures });
  const layout = buildScoreLayout(model.measures, width, { topOffset });

  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(layout.width, layout.height);
  const ctx = renderer.getContext();
  const svg = host.querySelector('svg');

  const records = drawSystems(ctx, svg, model, layout, { ...options, width, theme });

  if (svg) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Sheet music${title ? ` for ${title}` : ''}`);
    if (theme !== 'export') {
      svg.setAttribute('class', 'piano-sheet__svg');
    }
    if (title) addText(svg, LEFT_MARGIN, 26, title, 20, theme === 'export' ? '#14161a' : '#e8edf5');
    if (subtitle) addText(svg, LEFT_MARGIN, 45, subtitle, 12, theme === 'export' ? '#5b6270' : '#8d99ad');
  }

  return {
    model,
    layout,
    noteElements: resolveNoteElements(svg, records),
    svg,
  };
}

/** Renders a score to standalone SVG markup (for downloading the sheet as SVG). */
export function renderScoreSvg(score: Score, options: { width?: number } = {}): string {
  if (typeof document === 'undefined') {
    throw new Error('renderScoreSvg requires a browser DOM');
  }
  const width = Math.min(4000, Math.max(320, Math.round(options.width ?? 1200)));
  const title = (score?.title ?? '').trim();
  const subtitle = (score?.composer ?? '').trim();
  const host = document.createElement('div');
  const result = renderScoreInto(host, score, {
    width,
    maxMeasures: 400,
    theme: 'export',
    topOffset: title || subtitle ? 64 : 16,
    title,
    subtitle,
  });
  const svg = result.svg;
  if (!svg) throw new Error('Unable to render this score to SVG');

  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width', String(result.layout.width));
  svg.setAttribute('height', String(result.layout.height));

  const background = document.createElementNS(SVG_NS, 'rect');
  background.setAttribute('x', '0');
  background.setAttribute('y', '0');
  background.setAttribute('width', String(result.layout.width));
  background.setAttribute('height', String(result.layout.height));
  background.setAttribute('fill', '#ffffff');
  svg.insertBefore(background, svg.firstChild);

  return svg.outerHTML;
}

export interface ScoreSvgPages {
  /** One standalone SVG per A4 page. */
  pages: string[];
  /** Page width in SVG px. */
  width: number;
  /** Content height of each page (varies with the systems it holds). */
  pageHeights: number[];
  /** Number of systems on each page (useful for tests). */
  systemsPerPage: number[];
}

/**
 * Renders a score as paginated standalone SVG pages (A4 aspect ratio by
 * default). Pages break only between systems, and their viewBox ends at the
 * last system, so no staff is ever cut or repeated on the next page.
 */
export function renderScorePagesSvg(
  score: Score,
  options: { width?: number; pageHeight?: number } = {},
): ScoreSvgPages {
  if (typeof document === 'undefined') {
    throw new Error('renderScorePagesSvg requires a browser DOM');
  }
  const width = Math.min(2000, Math.max(320, Math.round(options.width ?? 794)));
  const pageHeight = Math.max(400, Math.round(options.pageHeight ?? width * 1.4142));
  const title = (score?.title ?? '').trim();
  const subtitle = (score?.composer ?? '').trim();
  const host = document.createElement('div');
  const result = renderScoreInto(host, score, {
    width,
    maxMeasures: 400,
    theme: 'export',
    topOffset: title || subtitle ? 64 : 16,
    title,
    subtitle,
  });
  const svg = result.svg;
  if (!svg) throw new Error('Unable to render this score to SVG');

  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width', String(result.layout.width));
  svg.setAttribute('height', String(result.layout.height));

  const background = document.createElementNS(SVG_NS, 'rect');
  background.setAttribute('x', '0');
  background.setAttribute('y', '0');
  background.setAttribute('width', String(result.layout.width));
  background.setAttribute('height', String(result.layout.height));
  background.setAttribute('fill', '#ffffff');
  svg.insertBefore(background, svg.firstChild);

  // Break pages between systems so staves are never cut in half.
  const groups: Array<Array<{ index: number; top: number; height: number; startBeat: number; endBeat: number }>> = [];
  let current: Array<{ index: number; top: number; height: number; startBeat: number; endBeat: number }> = [];
  let pageStart = 0;
  for (const system of result.layout.systems) {
    const bottom = system.top + system.height;
    if (current.length && bottom - pageStart > pageHeight) {
      groups.push(current);
      current = [];
      pageStart = system.top;
    }
    current.push({
      index: system.index,
      top: system.top,
      height: system.height,
      startBeat: system.startBeat,
      endBeat: system.endBeat,
    });
  }
  if (current.length) groups.push(current);

  const shiftTimed = <T extends { beat: number }>(events: readonly T[], start: number): T[] => {
    const atStart = events.filter((event) => event.beat <= start).at(-1);
    const later = events
      .filter((event) => event.beat > start)
      .map((event) => ({ ...event, beat: event.beat - start }));
    return atStart ? [{ ...atStart, beat: 0 }, ...later] : later;
  };

  const pageHeights: number[] = [];
  const pages = groups.map((group, pageIndex) => {
    const startBeat = group[0].startBeat;
    const endBeat = group[group.length - 1].endBeat;
    const pageScore: Score = {
      ...score,
      title: pageIndex === 0 ? score.title : '',
      composer: pageIndex === 0 ? score.composer : '',
      notes: score.notes
        .filter((note) => note.start >= startBeat && note.start < endBeat)
        .map((note) => ({
          ...note,
          start: note.start - startBeat,
          duration: Math.min(note.duration, endBeat - note.start),
        })),
      tempo: shiftTimed(score.tempo, startBeat),
      timeSignatures: shiftTimed(score.timeSignatures, startBeat),
      lengthBeats: endBeat - startBeat,
    };
    const title = pageScore.title;
    const subtitle = pageScore.composer;
    const pageHost = document.createElement('div');
    const pageResult = renderScoreInto(pageHost, pageScore, {
      width,
      maxMeasures: 400,
      theme: 'export',
      topOffset: title || subtitle ? 64 : 16,
      title,
      subtitle,
    });
    const pageSvg = pageResult.svg;
    if (!pageSvg) throw new Error('Unable to render a PDF page.');
    pageSvg.setAttribute('xmlns', SVG_NS);
    pageSvg.setAttribute('width', String(pageResult.layout.width));
    pageSvg.setAttribute('height', String(pageResult.layout.height));

    const pageBackground = document.createElementNS(SVG_NS, 'rect');
    pageBackground.setAttribute('x', '0');
    pageBackground.setAttribute('y', '0');
    pageBackground.setAttribute('width', String(pageResult.layout.width));
    pageBackground.setAttribute('height', String(pageResult.layout.height));
    pageBackground.setAttribute('fill', '#ffffff');
    pageSvg.insertBefore(pageBackground, pageSvg.firstChild);

    pageHeights.push(pageResult.layout.height);
    return pageSvg.outerHTML;
  });

  return {
    pages,
    width,
    pageHeights,
    systemsPerPage: groups.map((group) => group.length),
  };
}

export { LEFT_MARGIN, RIGHT_MARGIN };
