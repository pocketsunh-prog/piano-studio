/**
 * PDF export: paginate the rendered sheet by system, then draw each A4 page
 * with jsPDF + svg2pdf. Both libraries are loaded lazily so the main bundle
 * stays small and the (fairly large) PDF toolchain only loads on demand.
 */
import type { Score } from '../music/types';
import { renderScorePagesSvg } from '../sheet/renderer';

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 28;

function diatonicPitchClasses(fifths: number, mode: 'major' | 'minor'): Set<number> {
  const tonic = (((fifths * 7) % 12) + 12) % 12;
  const intervals = mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return new Set(intervals.map((interval) => (tonic + interval) % 12));
}

/** Very chromatic or note-dense scores get more horizontal room per measure. */
function isDenseScore(score: Score): boolean {
  if (!score.notes.length) return false;
  const meter = score.timeSignatures[0];
  const barBeats =
    meter && meter.numerator > 0 && meter.denominator > 0
      ? (meter.numerator * 4) / meter.denominator
      : 4;
  const bars = Math.max(1, Math.ceil(score.lengthBeats / barBeats));
  const notesPerBar = score.notes.length / bars;
  const keyPcs = diatonicPitchClasses(score.keySignature.fifths, score.keySignature.mode);
  let accidentals = 0;
  for (const note of score.notes) {
    if (!keyPcs.has(((note.midi % 12) + 12) % 12)) accidentals += 1;
  }
  const accidentalRatio = accidentals / score.notes.length;
  return notesPerBar >= 14 || accidentalRatio >= 0.3;
}

export interface ScorePdfResult {
  blob: Blob;
  pages: number;
}

export async function createScorePdf(score: Score): Promise<ScorePdfResult> {
  // A roomier layout than the screen: two measures per system normally, one
  // for very chromatic/dense scores, with a larger effective note size.
  const dense = isDenseScore(score);
  const { pages, width, pageHeights } = renderScorePagesSvg(score, {
    width: 620,
    pageHeight: 900,
    measuresPerSystem: dense ? 1 : 2,
  });
  if (!pages.length) throw new Error('This score has no pages to export.');

  const { jsPDF } = await import('jspdf');
  await import('svg2pdf.js');

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
    compress: true,
    putOnlyUsedFonts: true,
  });
  pdf.setProperties({
    title: score.title || 'Piano sheet',
    subject: 'Piano sheet exported from Piano Studio',
    author: score.composer || 'Piano Studio',
    creator: 'Piano Studio',
  });

  const usableWidth = A4_WIDTH - MARGIN * 2;
  const parser = new DOMParser();
  for (let index = 0; index < pages.length; index += 1) {
    if (index > 0) pdf.addPage('a4', 'portrait');
    const usableHeight = usableWidth * (pageHeights[index] / width);
    const documentNode = parser.parseFromString(pages[index], 'image/svg+xml');
    const svg = documentNode.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') {
      throw new Error('Could not render a PDF page from the sheet.');
    }
    await pdf.svg(svg, {
      x: MARGIN,
      y: MARGIN,
      width: usableWidth,
      height: usableHeight,
      loadExternalStyleSheets: false,
      loadImages: false,
    });

    pdf.setFontSize(8);
    pdf.setTextColor(120);
    pdf.text(`Piano Studio · page ${index + 1} / ${pages.length}`, A4_WIDTH / 2, A4_HEIGHT - 16, {
      align: 'center',
    });
  }

  return { blob: pdf.output('blob'), pages: pages.length };
}
