/**
 * Browser-side helpers to turn user files into image data-URLs for the
 * vision-based AI import (POST /api/parse-freeform, `images` field).
 *
 * - Images (PNG/JPG/WEBP…) are read directly and downscaled if huge.
 * - PDFs are rasterised page-by-page with pdf.js so scanned/print statements
 *   can be OCR'd by the vision model exactly like a photo.
 *
 * Returns JPEG data-URLs (smaller than PNG) to keep the request payload and the
 * model's image-token cost down.
 */
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const MAX_PDF_PAGES = 10;   // cap pages so a 200-page PDF can't melt the browser
const PDF_SCALE     = 2;    // render at 2× device units → legible text for OCR
const MAX_IMAGE_DIM = 1600; // longest edge for plain images; bigger gets downscaled
const JPEG_QUALITY  = 0.85;

const isPdf   = (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
const isImage = (f) => f.type.startsWith('image/');

/** True when this file should go through the vision pipeline (image/PDF) vs. text. */
export const isVisualFile = (f) => isPdf(f) || isImage(f);

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload  = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Downscale an image data-URL so its longest edge ≤ MAX_IMAGE_DIM, re-encode JPEG.
async function downscaleImage(dataUrl) {
  const img = await loadImage(dataUrl);
  const longest = Math.max(img.width, img.height);
  if (longest <= MAX_IMAGE_DIM) return dataUrl;
  const ratio = MAX_IMAGE_DIM / longest;
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(img.width * ratio);
  canvas.height = Math.round(img.height * ratio);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

async function rasterizePdf(file) {
  const buf = await file.arrayBuffer();
  // isEvalSupported: false — la CSP no lleva 'unsafe-eval' (tools/csp.test.js):
  // con el valor por defecto pdf.js compila las funciones PostScript de algunos
  // PDF con `new Function`, que la CSP bloquea. Así usa su intérprete.
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const out = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: PDF_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    out.push(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
    page.cleanup();
  }
  return out;
}

/**
 * Convert one file into one or more JPEG data-URLs.
 * Images → [dataUrl]; PDFs → one entry per rendered page; other → [].
 */
export async function fileToImageDataUrls(file) {
  if (isPdf(file))   return rasterizePdf(file);
  if (isImage(file)) return [await downscaleImage(await readAsDataUrl(file))];
  return [];
}
