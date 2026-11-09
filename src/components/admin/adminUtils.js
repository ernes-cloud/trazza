import { supabase } from '@/lib/customSupabaseClient';

export function fmtNum(n) {
  if (n === undefined || n === null) return '—';
  if (n === Infinity) return '∞';
  return Number(n).toLocaleString();
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

export async function adminFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  return fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(options.headers || {}),
    },
  });
}
