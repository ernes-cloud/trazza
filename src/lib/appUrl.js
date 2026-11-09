/**
 * Public site URL for the SPA and prerender. Override with VITE_APP_URL.
 */
const DEFAULT_APP_URL = 'https://example.com';

function viteOrProcessEnv(key) {
  const fromVite = import.meta.env?.[key];
  if (fromVite != null && String(fromVite).trim()) return String(fromVite).trim();
  const fromNode = globalThis.process?.env?.[key];
  if (fromNode != null && String(fromNode).trim()) return String(fromNode).trim();
  return undefined;
}

function stripTrailingSlashes(url) {
  return String(url).replace(/\/+$/, '');
}

function originWithPath(parsed) {
  const pathPart = parsed.pathname === '/' ? '' : parsed.pathname;
  return stripTrailingSlashes(parsed.origin + pathPart);
}

function parseAppUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return DEFAULT_APP_URL;

  if (trimmed.startsWith('//')) {
    throw new Error('VITE_APP_URL must use https:// (protocol-relative URLs are not allowed)');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('VITE_APP_URL must be a valid absolute https:// URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('VITE_APP_URL must use https:// (or http:// on localhost)');
  }

  if (parsed.protocol === 'https:') {
    return originWithPath(parsed);
  }

  const host = parsed.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return originWithPath(parsed);
  }

  throw new Error('VITE_APP_URL must use https://; http:// is only allowed on localhost');
}

export function getAppUrl() {
  const fromEnv = viteOrProcessEnv('VITE_APP_URL');
  return parseAppUrl(fromEnv);
}

/** Import-safe re-export for tests and legacy imports; use {@link getAppUrl} at runtime when env may be invalid. */
export const SITE_URL = (() => {
  try {
    return getAppUrl();
  } catch {
    return DEFAULT_APP_URL;
  }
})();

export function absoluteUrl(path = '/') {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${getAppUrl()}${clean === '/' ? '/' : clean.replace(/\/+$/, '')}`;
}
