import { describe, it, expect } from 'vitest';
import { sanitiseImages, IMG_DATAURL_RE, DEFAULT_MAX_IMAGES } from './visionImages.js';

const png  = 'data:image/png;base64,iVBORw0KGgo=';
const jpg  = 'data:image/jpg;base64,/9j/4AAQSkZJRg==';
const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const webp = 'data:image/webp;base64,UklGRiQAAABXRUJQ';

describe('IMG_DATAURL_RE', () => {
  it('accepts png/jpg/jpeg/webp data-URLs and rejects others', () => {
    expect(IMG_DATAURL_RE.test(png)).toBe(true);
    expect(IMG_DATAURL_RE.test(jpg)).toBe(true);
    expect(IMG_DATAURL_RE.test(jpeg)).toBe(true);
    expect(IMG_DATAURL_RE.test(webp)).toBe(true);
    expect(IMG_DATAURL_RE.test('data:application/pdf;base64,JVBERi0=')).toBe(false);
    expect(IMG_DATAURL_RE.test('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(IMG_DATAURL_RE.test('https://example.com/a.png')).toBe(false);
  });
});

describe('sanitiseImages', () => {
  it('returns [] when input is not an array', () => {
    expect(sanitiseImages(undefined)).toEqual([]);
    expect(sanitiseImages(null)).toEqual([]);
    expect(sanitiseImages('data:image/png;base64,AAAA')).toEqual([]);
  });

  it('keeps only valid image data-URLs and drops the rest', () => {
    const out = sanitiseImages([png, 'not-a-data-url', 42, null, jpeg, 'data:application/pdf;base64,JVBERi0=']);
    expect(out).toEqual([png, jpeg]);
  });

  it('drops images larger than maxChars', () => {
    const big = png + 'A'.repeat(100);
    const out = sanitiseImages([png, big], { maxChars: png.length + 10 });
    expect(out).toEqual([png]);
  });

  it('caps the number of images at max', () => {
    const many = Array.from({ length: DEFAULT_MAX_IMAGES + 5 }, () => png);
    expect(sanitiseImages(many)).toHaveLength(DEFAULT_MAX_IMAGES);
    expect(sanitiseImages(many, { max: 2 })).toHaveLength(2);
  });
});
