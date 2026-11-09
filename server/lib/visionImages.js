/**
 * Pure validation for image inputs to the vision-based free-form import.
 *
 * Extracted from routes/parseFreeform.js so it can be unit-tested without
 * pulling in the Groq SDK. Keep dependency-free.
 */

// Accept only the still-image formats Groq vision supports, as base64 data-URLs.
export const IMG_DATAURL_RE = /^data:image\/(png|jpe?g|webp);base64,/i;

export const DEFAULT_MAX_IMAGES = 8;          // images (incl. PDF pages) per request
export const DEFAULT_MAX_IMAGE_CHARS = 4_000_000; // ~3 MB encoded — drop anything bigger

/**
 * Keep only well-formed, reasonably-sized image data-URLs, capped at `max`.
 * Anything that isn't a string, isn't a supported image data-URL, or is too
 * large is silently dropped (the caller decides what to do with an empty list).
 *
 * @param {unknown} images
 * @param {{ max?: number, maxChars?: number }} [opts]
 * @returns {string[]}
 */
export function sanitiseImages(images, opts = {}) {
  const max      = opts.max      ?? DEFAULT_MAX_IMAGES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_IMAGE_CHARS;
  if (!Array.isArray(images)) return [];
  return images
    .filter(s => typeof s === 'string' && IMG_DATAURL_RE.test(s) && s.length <= maxChars)
    .slice(0, max);
}
