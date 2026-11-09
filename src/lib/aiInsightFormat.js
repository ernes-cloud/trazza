/**
 * Parser for the section/bullet format every Trazza AI narrative uses
 * (portfolio score, earnings analysis…). PURE — no React, no I/O — so the
 * layout rules are unit-testable in a project without DOM testing.
 *
 * Input: raw model output. Output: ordered blocks the UI renders as it likes.
 *   { type: 'header',    text, emoji }
 *   { type: 'bullet',    text }
 *   { type: 'paragraph', text }
 *
 * Inline **bold** is left untouched — rendering it is the caller's job
 * (see renderInline in @/components/ui/AiInsightBlocks).
 */

const MAX_HEADER_LEN = 60;

export function parseInsightBlocks(insight) {
  if (!insight || typeof insight !== 'string') return [];

  return insight
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      // Un "*" suelto es viñeta; "**" abre una negrita, no una viñeta.
      const BULLET = /^(?:[·•-]|\*(?!\*))/;
      const isBullet = BULLET.test(l) || /^\d+\.\s/.test(l);
      const text = l.replace(/^(?:[·•-]|\*(?!\*))\s*/, '').replace(/^\d+\.\s*/, '');
      if (isBullet) return { type: 'bullet', text };

      const spaceIdx = text.indexOf(' ');
      const hasEmoji = spaceIdx > 0 && (text.codePointAt(0) || 0) > 255;
      // El modelo a veces escribe la cabecera en negrita ("📊 **Diagnóstico**"):
      // las cabeceras se pintan sin renderInline, así que fuera los asteriscos.
      const cleanText = (hasEmoji ? text.slice(spaceIdx + 1) : text).replace(/^\*\*(.+)\*\*$/, '$1');

      // A real section header carries an emoji, or is short and fully uppercase
      const isSection = hasEmoji || (cleanText === cleanText.toUpperCase() && cleanText.length < MAX_HEADER_LEN);
      if (isSection) {
        return { type: 'header', text: cleanText, emoji: hasEmoji ? text.slice(0, spaceIdx) : null };
      }
      return { type: 'paragraph', text: cleanText };
    });
}
