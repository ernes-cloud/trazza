/**
 * Lee TODAS las filas de una consulta de Supabase, página a página.
 *
 * PostgREST corta cada respuesta en 1.000 filas (max-rows de Supabase) sin
 * avisar: el cron leía `positions` de todos los usuarios de una vez, y a partir
 * de la fila 1.000 los usuarios restantes dejarían de recibir avisos sin que
 * nada fallara. `build` crea la consulta de nuevo en cada página (un builder de
 * supabase-js no se puede reutilizar tras el await). La consulta debe llevar un
 * `order` estable para que las páginas no se solapen.
 *
 * @param {() => any} build  () => supabase.from(...).select(...)...order(...)
 * @param {number} [pageSize]
 * @returns {Promise<{ data: any[] | null, error: any }>}
 */
export async function fetchAllRows(build, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return { data: rows, error: null };
  }
}
