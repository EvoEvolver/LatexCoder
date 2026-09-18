import type { PDFDocumentProxy } from 'pdfjs-dist';

// Use the same two compositing steps in the canvas preview and vector export.
// White becomes RGB(30,36,34); black becomes RGB(226,232,230).
const shade = { r: 30 / 59, g: 36 / 59, b: 34 / 59, opacity: 59 / 255 };

export function darkenPdfCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')!;
  context.save();
  context.resetTransform();
  context.globalCompositeOperation = 'difference';
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = `rgba(${shade.r * 255},${shade.g * 255},${shade.b * 255},${shade.opacity})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();
}

/** Keep original page streams, fonts, links, page sizes and selectable text. */
export async function createDarkPdf(bytes: Uint8Array) {
  const { PDFDocument, BlendMode, rgb } = await import('pdf-lib');
  const document = await PDFDocument.load(bytes);
  for (const page of document.getPages()) {
    const { x, y, width, height } = page.getMediaBox();
    // PDF viewers assume a white page; make that implicit backdrop explicit.
    const contents = page.node.normalizedEntries().Contents;
    const backdrop = document.context.register(document.context.flateStream(`q 1 1 1 rg ${x} ${y} ${width} ${height} re f Q\n`));
    if (contents) contents.insert(0, backdrop);
    else page.node.addContentStream(backdrop);
    page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1), blendMode: BlendMode.Difference });
    page.drawRectangle({ x, y, width, height, color: rgb(shade.r, shade.g, shade.b), opacity: shade.opacity });
  }
  return document.save();
}

export async function downloadPdf(document: PDFDocumentProxy, dark: boolean, filename: string) {
  const original = await document.getData();
  return downloadPdfBytes(original, dark, filename);
}

export async function downloadPdfBytes(original: Uint8Array, dark: boolean, filename: string) {
  const data = dark ? await createDarkPdf(original) : original;
  const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'application/pdf' }));
  const link = Object.assign(window.document.createElement('a'), { href: url, download: `${filename}${dark ? '-dark' : ''}.pdf` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
