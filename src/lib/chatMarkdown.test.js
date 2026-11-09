import { describe, it, expect } from 'vitest';
import { parseChatMarkdown } from './chatMarkdown';

describe('parseChatMarkdown', () => {
  it('reconoce una tabla GFM (la respuesta real que no se leía en el panel)', () => {
    const md = [
      'Estas son tus posiciones:',
      '',
      '| Activo | Valor | Peso |',
      '|--------|-------|------|',
      '| Meta | **9.701 €** | 27,7 % |',
      '| Microsoft | 9.654 € | 27,6 % |',
      '',
      'Total **32.146 €**.',
    ].join('\n');
    expect(parseChatMarkdown(md)).toEqual([
      { type: 'paragraph', text: 'Estas son tus posiciones:' },
      { type: 'table', headers: ['Activo', 'Valor', 'Peso'], rows: [['Meta', '**9.701 €**', '27,7 %'], ['Microsoft', '9.654 €', '27,6 %']] },
      { type: 'paragraph', text: 'Total **32.146 €**.' },
    ]);
  });

  it('listas numeradas con sub-viñetas sangradas', () => {
    const md = '1. **Sobre tu cartera**:\n   - valor total\n   - posiciones\n2. **Sobre Trazza**';
    const [list] = parseChatMarkdown(md);
    expect(list.type).toBe('list');
    expect(list.ordered).toBe(true);
    expect(list.items).toEqual([
      { text: '**Sobre tu cartera**:', children: ['valor total', 'posiciones'] },
      { text: '**Sobre Trazza**', children: [] },
    ]);
  });

  it('viñetas simples, encabezados y párrafos multilínea', () => {
    const blocks = parseChatMarkdown('### Resumen\nLínea uno\nlínea dos\n\n- a\n- b');
    expect(blocks).toEqual([
      { type: 'heading', text: 'Resumen' },
      { type: 'paragraph', text: 'Línea uno\nlínea dos' },
      { type: 'list', ordered: false, items: [{ text: 'a', children: [] }, { text: 'b', children: [] }] },
    ]);
  });

  it('una barra suelta en el texto no se confunde con una tabla', () => {
    expect(parseChatMarkdown('Valor | peso')).toEqual([{ type: 'paragraph', text: 'Valor | peso' }]);
  });

  it('texto vacío o nulo', () => {
    expect(parseChatMarkdown('')).toEqual([]);
    expect(parseChatMarkdown(null)).toEqual([]);
  });
});
