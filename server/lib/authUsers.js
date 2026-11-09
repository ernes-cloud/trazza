/**
 * Todas las cuentas de Supabase Auth (email, confirmación, metadatos), paginado.
 * `listUsers` corta en 1000 por página; con el tope de páginas no hay bucle
 * infinito si la API devolviera siempre páginas llenas.
 */

const PER_PAGE = 1000;
const MAX_PAGES = 50;

export async function listAllAuthUsers(supabaseAdmin) {
  const users = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const batch = data?.users || [];
    users.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return users;
}
