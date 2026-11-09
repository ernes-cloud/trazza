/**
 * GET /api/admin/parser-candidates
 *
 * Sólo admin. Lee la telemetría de imports y responde a una pregunta concreta:
 * de todo lo que hoy depende de la IA, ¿qué formato merece un parser dedicado?
 *
 * La decisión NO la toma el volumen de fallos sino la intersección de volumen,
 * dolor y REGULARIDAD del texto — ver `server/lib/parserCandidates.js`, donde
 * está la lógica pura y testeada. Aquí sólo se leen filas y se pasan.
 *
 * Parámetros opcionales:
 *   days=90         ventana que se mira (por defecto 90 días)
 *   minIntentos=3   por debajo de eso es una anécdota, no un patrón
 */

import { supabaseAdmin } from '../lib/adminSupabase.js';
import { requireAdmin } from '../lib/requireAdmin.js';
import { rankParserCandidates } from '../lib/parserCandidates.js';

const MAX_FILAS = 2_000;

export async function adminParserCandidates(req, res) {
  // requireAdmin recibe el cliente service-role como TERCER argumento y ya
  // responde él mismo (401 sin sesión, 503 sin Supabase): aquí sólo se corta.
  const admin = await requireAdmin(req, res, supabaseAdmin);
  if (!admin) return undefined;

  const days = Math.min(365, Math.max(1, Number(req.query?.days) || 90));
  const minIntentos = Math.max(1, Number(req.query?.minIntentos) || 3);
  const desde = new Date(Date.now() - days * 86_400_000).toISOString();

  // `select('*')` a propósito: import_logs crece por migraciones y una lista de
  // columnas nombradas devuelve 400 ENTERO en cuanto una no existe todavía.
  const { data, error } = await supabaseAdmin
    .from('import_logs')
    .select('*')
    .gte('created_at', desde)
    .order('created_at', { ascending: false })
    .limit(MAX_FILAS);

  if (error) {
    console.error('[adminParserCandidates] consulta fallida:', error.message);
    return res.status(500).json({ error: error.message });
  }

  const candidatos = rankParserCandidates(data || [], { minIntentos });

  return res.json({
    ventanaDias: days,
    intentosAnalizados: (data || []).length,
    truncado: (data || []).length >= MAX_FILAS,
    candidatos: candidatos.map(({ muestras, ...resto }) => ({ ...resto, muestrasDisponibles: muestras })),
  });
}
