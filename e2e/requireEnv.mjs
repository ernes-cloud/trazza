// Los smokes no eligen a qué Express hablan: lo decide el vite que sirve BASE_URL.
// Exigir VITE_VALIDATION_SERVER_URL aquí obliga a decirlo al lanzarlos (el vite
// sin fallback ya no manda nada al :4000 de producción por omisión).
export function requireValidationServerUrl(env = process.env) {
  const url = env.VITE_VALIDATION_SERVER_URL;
  if (!url) {
    throw new Error('VITE_VALIDATION_SERVER_URL no está definida: lanza el smoke con la misma URL del Express LOCAL con la que arrancaste vite (nunca el de producción).');
  }
  return url;
}
