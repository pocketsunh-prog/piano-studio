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

export interface ScorePdfResult {
  blob: Blob;
  pages: number;
}

export async function createScorePdf(score: Score): Promise<ScorePdfResult> {
  const { pages, width, pageHeights } = renderScorePagesSvg(score, { width: 794 });
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
