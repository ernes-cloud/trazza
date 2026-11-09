import { describe, it, expect } from 'vitest';
import { calculateModifiedDietz } from './dietzAnalytics';

describe('Modified Dietz Algorithm', () => {
  it('Verifies the MVP test scenario: 8% return exactly', () => {
    // 1. Initial State
    const startValue = 10000;
    
    // 2. Mock Cash Flow: 5,000€ deposit on day 15 of a 30-day month
    const cashFlows = [
      { date: '2025-04-15', amount_in_eur: 5000, type: 'deposit' }
    ];
    
    // 3. Environment (30 days total for the test calculation math)
    const daysInMonth = 30; // April has 30 days
    
    // 4. End State (Yields 1,000€ in pure profit over the initial+flows)
    const endValue = 16000;

    // Ejecutar fórmula
    const result = calculateModifiedDietz(startValue, endValue, cashFlows, daysInMonth);

    /**
     * Matemática esperada:
     * Peso del flujo = (30 - 15) / 30 = 0.5
     * Flujo Ponderado = 5000 * 0.5 = 2500
     * Numerador = 16000 - 10000 - 5000 = 1000 (Ganancia pura)
     * Denominador = 10000 + 2500 = 12500
     * Resultado = 1000 / 12500 = 0.08 -> 8%
     */
    expect(result).toBe(8);
  });

  it('Handles negative flows (withdrawals) accurately', () => {
    // Escenario alternativo: Cartera estática pero con retirada parcial
    const startValue = 20000;
    
    // Retirada de 10.000 a mitad de mes (peso 0.5)
    const cashFlows = [
      { date: '2025-04-15', amount_in_eur: 10000, type: 'withdrawal' }
    ];
    
    // Valor inicial (20k). Retiro de 10k. Sin otras ganancias operativas, debería cerrar en 10k exactos = 0% de rentabilidad
    const expectedNeutralEndValue = 10000;
    
    const result = calculateModifiedDietz(startValue, expectedNeutralEndValue, cashFlows, 30);
    expect(result).toBe(0);
  });
});
