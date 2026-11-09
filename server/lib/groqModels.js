/**
 * Los modelos de Groq que usa la plataforma, en UN solo sitio.
 *
 * Estaban repetidos en seis rutas (cuatro de ellas con el id escrito a mano, sin
 * variable de entorno), así que cuando Groq retiró `llama-3.3-70b-versatile`
 * cayeron a la vez el chat de cartera, la puntuación, el análisis de resultados,
 * la validación de import, el análisis de CSV y el import por texto libre — y
 * arreglarlo obligaba a tocar seis ficheros y a redesplegar. Aquí un `.env`
 * basta.
 *
 * ⚠️ Groq da de baja modelos con poco aviso. Cuando una feature de IA deje de
 * responder, lo PRIMERO que hay que mirar es si el id sigue existiendo:
 *
 *   curl -s https://api.groq.com/openai/v1/models \
 *     -H "Authorization: Bearer $GROQ_API_KEY" | grep '"id"'
 *
 * Comprobado el 2026-09-13: los tres ids anteriores (`llama-3.3-70b-versatile`,
 * `llama-3.1-8b-instant` y `meta-llama/llama-4-scout-17b-16e-instruct`)
 * devolvían 404 `model_not_found`.
 */

/** Extracción y redacción. gpt-oss-120b verificado contra el import de texto libre. */
export const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';

/** Se usa UNA vez si el principal ya no existe (ver groqJson.js). */
export const TEXT_FALLBACK_MODEL = process.env.GROQ_TEXT_MODEL_FALLBACK || 'openai/gpt-oss-20b';

/**
 * Multimodal para capturas y páginas de PDF.
 *
 * ⚠️ Cuál de los modelos acepta imágenes NO se deduce del nombre: ninguno de
 * los disponibles lo lleva en el id, y el único que las acepta resultó ser
 * `qwen/qwen3.8-27b`. La forma de averiguarlo es MANDARLE UNA IMAGEN — los que
 * no la admiten responden "messages[0].content must be a string". Si algún día
 * deja de funcionar, se prueban todos con `scripts/` o a mano; tres minutos.
 *
 * Vacío significa "no hay ninguno": la ruta lo detecta y lo dice en vez de
 * fallar con un 404 críptico sobre un id inventado.
 */
export const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';

/** ¿Se puede leer una imagen ahora mismo? */
export const hasVisionModel = () => Boolean(VISION_MODEL);
