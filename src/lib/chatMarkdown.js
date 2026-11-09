/**
 * Markdown sencillo de las respuestas del chat de cartera → bloques que el
 * widget pinta SIN `dangerouslySetInnerHTML` (mismo criterio que el blog).
 *
 * El widget mostraba la respuesta como texto plano: los `**` y las tablas
 * markdown salían tal cual en un panel de 360 px. Aquí se reconocen:
 *   - encabezados (`#`, `##`, `###`) → 'heading'
 *   - listas con viñeta (`-`, `*`, `•`) o numeradas (`1.`), con un nivel de
 *     sangría → 'list'
 *   - tablas GFM (`| a | b |` + separador) → 'table' (el componente las pinta
 *     como TARJETAS apiladas: en un panel estrecho una tabla de 7 columnas no
 *     se puede leer)
 *   - el resto → 'paragraph'
 * Las negritas `**` se resuelven al pintar (renderInline).
 */

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const LIST_ITEM = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;

export function parseChatMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];

  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flushPara(); continue; }

    // Tabla: fila de cabecera seguida de separador
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushPara();
      const headers = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      i--;
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const h = line.match(/^\s*#{1,3}\s+(.*)$/);
    if (h) { flushPara(); blocks.push({ type: 'heading', text: h[1].trim() }); continue; }

    const li = line.match(LIST_ITEM);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]);
      const indent = li[1].length;
      const last = blocks[blocks.length - 1];
      const item = { text: li[3].trim(), children: [] };
      if (indent >= 2 && last?.type === 'list' && last.items.length) {
        last.items[last.items.length - 1].children.push(item.text);
      } else if (last?.type === 'list' && last.ordered === ordered && lines[i - 1]?.trim()) {
        last.items.push(item);
      } else {
        blocks.push({ type: 'list', ordered, items: [item] });
      }
      continue;
    }

    // Línea suelta justo debajo de un elemento de lista sangrado → continuación
    const last = blocks[blocks.length - 1];
    if (!para.length && last?.type === 'list' && /^\s{2,}\S/.test(line) && lines[i - 1]?.trim()) {
      const it = last.items[last.items.length - 1];
      it.text = `${it.text} ${line.trim()}`;
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  return blocks;
}
