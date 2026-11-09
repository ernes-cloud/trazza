/**
 * Public site origin (canonical HTTPS). Override with APP_URL in server .env.
 * Default matches production (OSS export rewrites to example.com in the public copy).
 */
const DEFAULT_APP_URL = 'https://example.com';

function stripTrailingSlashes(url) {
  return String(url).replace(/\/+$/, '');
}

function originWithPath(parsed) {
  const pathPart = parsed.pathname === '/' ? '' : parsed.pathname;
  return stripTrailingSlashes(parsed.origin + pathPart);
}

/**
 * @param {string} raw
 */
export function parseAppUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return DEFAULT_APP_URL;

  if (trimmed.startsWith('//')) {
    throw new Error('APP_URL must use https:// (protocol-relative URLs are not allowed)');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('APP_URL must be a valid absolute https:// URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('APP_URL must use https:// (or http:// on localhost)');
  }

  if (parsed.protocol === 'https:') {
    return originWithPath(parsed);
  }

  const host = parsed.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return originWithPath(parsed);
  }

  throw new Error('APP_URL must use https://; http:// is only allowed on localhost');
}

export function getAppUrl() {
  const raw = process.env.APP_URL || process.env.VITE_APP_URL || '';
  return parseAppUrl(raw);
}

/** Hostname without scheme (e.g. example.com). */
export function getAppHostname() {
  try {
    return new URL(getAppUrl()).hostname;
  } catch {
    return 'example.com';
  }
}
