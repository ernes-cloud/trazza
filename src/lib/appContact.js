import { getAppUrl } from './appUrl.js';

function defaultMailbox(local) {
  try {
    const host = new URL(getAppUrl()).hostname;
    return `${local}@${host}`;
  } catch {
    return `${local}@example.com`;
  }
}

export function getContactEmail() {
  const v =
    import.meta.env?.VITE_CONTACT_EMAIL ??
    globalThis.process?.env?.VITE_CONTACT_EMAIL;
  if (v && String(v).trim()) return String(v).trim();
  return defaultMailbox('hola');
}
