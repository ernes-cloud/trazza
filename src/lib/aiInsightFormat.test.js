import { describe, it, expect } from 'vitest';
import { parseInsightBlocks } from './aiInsightFormat';

describe('parseInsightBlocks', () => {
  it('returns an empty array for empty or non-string input', () => {
    expect(parseInsightBlocks('')).toEqual([]);
    expect(parseInsightBlocks(null)).toEqual([]);
    expect(parseInsightBlocks(undefined)).toEqual([]);
    expect(parseInsightBlocks(42)).toEqual([]);
  });

  it('detects emoji section headers and separates the emoji from the label', () => {
    const [block] = parseInsightBlocks('📊 Los números');
    expect(block).toEqual({ type: 'header', text: 'Los números', emoji: '📊' });
  });

  it('treats short all-caps lines as headers', () => {
    const [block] = parseInsightBlocks('PUNTOS CRÍTICOS');
    expect(block.type).toBe('header');
    expect(block.emoji).toBeNull();
  });

  it('recognises ·, •, -, * and numbered bullets, stripping the marker', () => {
    const blocks = parseInsightBlocks('· uno\n• dos\n- tres\n* cuatro\n1. cinco');
    expect(blocks.map(b => b.type)).toEqual(Array(5).fill('bullet'));
    expect(blocks.map(b => b.text)).toEqual(['uno', 'dos', 'tres', 'cuatro', 'cinco']);
  });

  it('classifies ordinary prose as a paragraph', () => {
    const [block] = parseInsightBlocks('Apple presentó un BPA de 1,52 dólares por acción.');
    expect(block.type).toBe('paragraph');
  });

  it('does not mistake a long uppercase-free sentence for a header', () => {
    const long = 'a'.repeat(80);
    expect(parseInsightBlocks(long)[0].type).toBe('paragraph');
  });

  it('drops blank lines and trims whitespace', () => {
    const blocks = parseInsightBlocks('\n  📊 Los números  \n\n   texto   \n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toBe('texto');
  });

  it('leaves inline **bold** markers untouched for the renderer', () => {
    const [block] = parseInsightBlocks('· Sorpresa de **+6.3%** sobre el consenso');
    expect(block.text).toBe('Sorpresa de **+6.3%** sobre el consenso');
  });

  it('parses a full three-section narrative in order', () => {
    const insight = [
      '📊 Los números',
      'BPA de **1.52** frente a **1.43** estimados.',
      '💬 Reacción del mercado',
      'La acción sube un **3.4%** en la sesión.',
      '🔭 Qué vigilar',
      '· Margen bruto del próximo trimestre',
      '· Guidance de servicios',
    ].join('\n');

    expect(parseInsightBlocks(insight).map(b => b.type)).toEqual([
      'header', 'paragraph', 'header', 'paragraph', 'header', 'bullet', 'bullet',
    ]);
  });
});

describe('parseInsightBlocks — cabeceras en negrita (2026-10-03)', () => {
  it('quita los ** que envuelven una cabecera con emoji', () => {
    expect(parseInsightBlocks('📊 **Diagnóstico Actual**')).toEqual([
      { type: 'header', text: 'Diagnóstico Actual', emoji: '📊' },
    ]);
  });

  it('una línea que empieza en **negrita** no es una viñeta', () => {
    const [block] = parseInsightBlocks('**32.146 €** de valor total, con plusvalía.');
    expect(block.type).toBe('paragraph');
    expect(block.text).toBe('**32.146 €** de valor total, con plusvalía.');
  });

  it('una cabecera solo en negrita y mayúsculas sigue siendo cabecera, sin asteriscos', () => {
    expect(parseInsightBlocks('**PUNTOS CRÍTICOS**')).toEqual([
      { type: 'header', text: 'PUNTOS CRÍTICOS', emoji: null },
    ]);
  });

  it('las viñetas con * simple siguen funcionando', () => {
    expect(parseInsightBlocks('* Reducir costes')).toEqual([{ type: 'bullet', text: 'Reducir costes' }]);
  });
});
