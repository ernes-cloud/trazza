/**
 * GET /share/:token — la PÁGINA de una cartera compartida, con su vista previa.
 *
 * Sirve el shell de la SPA (la página se pinta igual en el navegador), pero con
 * el <head> propio de esa cartera: título, descripción e imagen para
 * WhatsApp/Telegram/X/LinkedIn, que no ejecutan JS. Lo que dice la vista previa
 * lo decide `lib/shareMeta.js` (puro, testeado).
 *
 * La base es `app.html` (shell neutro de generate-seo) y, si no existe,
 * `index.html` con #root vaciado: desde el prerender, index.html lleva la
 * portada dentro de #root y se veía la home al abrir un enlace compartido.
 * Orden de candidatos y normalización en `lib/shareHtml.js` (puro, testeado).
 *
 * Nunca rompe la página: si la BD falla, se sirve la vista previa genérica; si
 * no hay ninguna base legible, 503 (sin ella no hay página que servir).
 * nginx manda aquí `location /share/` (ver CLAUDE.md → Producción).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabaseAdmin } from '../lib/adminSupabase.js';
import { buildShareMeta } from '../lib/shareMeta.js';
import { shareHtmlCandidates, readShareBase } from '../lib/shareHtml.js';
import { SITE_NAME, OG_IMAGE, absoluteUrl } from '../../src/lib/siteMeta.js';
import { buildHeadTags, injectHead, stripHelmetTags } from '../../src/lib/seoHead.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_CANDIDATES = shareHtmlCandidates({ env: process.env, distDir: path.resolve(HERE, '../../dist') });
const BASE_TTL_MS = 60_000; // un despliegue nuevo se nota en un minuto

let baseCache = { html: null, at: 0 };

async function readBaseHtml() {
  if (baseCache.html && Date.now() - baseCache.at < BASE_TTL_MS) return baseCache.html;
  const found = await readShareBase(BASE_CANDIDATES, (file) => fs.readFile(file, 'utf8'));
  if (!found) return null;
  baseCache = { html: found.html, at: Date.now() };
  return found.html;
}

async function loadShare(token) {
  if (!supabaseAdmin || !UUID_RE.test(token)) return null;
  const { data, error } = await supabaseAdmin
    .from('portfolio_shares')
    // Del snapshot solo hace falta `metrics` (el resto son todas las posiciones).
    .select('label, mode, config, expires_at, cached_metrics, snapshot_metrics:snapshot_data->metrics')
    .eq('id', token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const { snapshot_metrics, ...rest } = data;
  return { ...rest, snapshot_data: snapshot_metrics ? { metrics: snapshot_metrics } : null };
}

export async function sharePage(req, res) {
  const base = await readBaseHtml();
  if (!base) return res.status(503).type('text/plain').send('Service unavailable');

  const token = String(req.params.token || '');
  let share = null;
  try {
    share = await loadShare(token);
  } catch (e) {
    console.error('[sharePage] DB error:', e.message);
  }

  const { title, description } = buildShareMeta(share);
  const url = absoluteUrl(`/share/${UUID_RE.test(token) ? token : ''}`);
  const tags = [
    '<meta data-react-helmet="true" name="robots" content="noindex, nofollow">',
    ...buildHeadTags({ title, description, url, siteName: SITE_NAME, image: OG_IMAGE }),
  ];

  let html;
  try {
    html = injectHead(stripHelmetTags(base), { title, tags, lang: 'es' });
  } catch (e) {
    console.error('[sharePage] inject failed:', e.message);
    html = base;
  }

  res.set('X-Robots-Tag', 'noindex, nofollow');
  // Corto: el título lo elige el dueño y puede cambiarlo o borrar el enlace.
  res.set('Cache-Control', 'public, max-age=300');
  return res.type('html').send(html);
}
