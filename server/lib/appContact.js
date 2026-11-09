/**
 * Contact / sender addresses — override via env (see .env.example).
 */
import { getAppHostname } from './appUrl.js';

function defaultMailbox(local) {
  return `${local}@${getAppHostname()}`;
}

export function getContactEmail() {
  const v = process.env.CONTACT_EMAIL;
  if (v && String(v).trim()) return String(v).trim();
  return defaultMailbox('hola');
}

export function getEmailFrom() {
  const v = process.env.EMAIL_FROM;
  if (v && String(v).trim()) return String(v).trim();
  return `Trazza <${defaultMailbox('noreply')}>`;
}

export function getPrivacyEmail() {
  const v = process.env.PRIVACY_EMAIL;
  if (v && String(v).trim()) return String(v).trim();
  return defaultMailbox('privacy');
}
