/**
 * Optional demo login via env (VITE_DEMO_EMAIL / VITE_DEMO_PASSWORD).
 * When either is empty, credential-based demo login is disabled.
 */
function viteOrProcessEnv(key) {
  const fromVite = import.meta.env?.[key];
  if (fromVite != null && String(fromVite).trim() !== '') return fromVite;
  const fromNode = globalThis.process?.env?.[key];
  if (fromNode != null) return fromNode;
  return undefined;
}

export function getDemoCredentials() {
  const email = String(viteOrProcessEnv('VITE_DEMO_EMAIL') || '').trim().toLowerCase();
  const password = viteOrProcessEnv('VITE_DEMO_PASSWORD') || '';
  if (!email || !password) return null;
  return { email, password };
}

export function isDemoCredentialLogin(email, password) {
  const cfg = getDemoCredentials();
  if (!cfg) return false;
  return String(email || '').trim().toLowerCase() === cfg.email && password === cfg.password;
}

export const DEMO_USER_IDS = new Set(['demo-user-id', 'demo-sample-user-id']);
