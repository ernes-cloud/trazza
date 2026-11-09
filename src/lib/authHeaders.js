import { supabase } from '@/lib/customSupabaseClient';

/**
 * Cabecera Authorization con el token de la sesión, o {} si no hay sesión
 * (modo demo, sesión caducada). Una sola copia: había tres idénticas en
 * dividendService, earningsService y eodhd.
 * @returns {Promise<{ Authorization?: string }>}
 */
export async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}
