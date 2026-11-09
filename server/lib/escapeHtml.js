// Escapa texto para interpolarlo en el HTML de un correo. Los títulos y
// mensajes de `notifications` llevan texto del usuario (la nota de un gasto
// recurrente, el nombre de un broker): sin escapar, un `<` rompía el correo y
// un `<a href>` acababa enviado desde nuestro dominio.
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}
