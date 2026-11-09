import { describe, it, expect } from 'vitest';
import { calculateModifiedDietz } from '../services/dietzAnalytics';

describe('Dietz Analytics - Edge Cases Matemáticos', () => {

  it('Apertura de cuenta (Valor Inicial = 0): Calcula rendimiento intrames sin Infinity/NaN', () => {
    // Escenario: 5000€ ingresados el día 10. Termina con 5200€. Mes de 31 días.
    const startValue = 0;
    const endValue = 5200;
    const cashFlows = [
      { date: '2025-01-10', amount_in_eur: 5000, type: 'deposit' }
    ];
    // weight = (31 - 10) / 31 = 21 / 31 = 0.6774
    // W_F = 5000 * 0.6774 = 3387.0967
    // Numerador = 5200 - 0 - 5000 = 200
    // Denominador = 0 + 3387.0967 = 3387.0967
    // Rendimiento = 200 / 3387.0967 = 5.904%
    
    const result = calculateModifiedDietz(startValue, endValue, cashFlows, 31);
    expect(result).toBeCloseTo(5.904, 2);
  });

  it('Múltiples flujos complejos con depósitos y retiros intercalados', () => {
    // Escenario: 2000€ el día 5, retira 500€ el día 15, deposita 1000€ el día 25.
    // StartValue = 10000. EndValue = 13500. Mes de 30 días.
    const cashFlows = [
      { date: '2025-04-05', amount_in_eur: 2000, type: 'deposit' }, // W = 25/30
      { date: '2025-04-15', amount_in_eur: 500, type: 'withdrawal' }, // W = 15/30
      { date: '2025-04-25', amount_in_eur: 1000, type: 'deposit' } // W = 5/30
    ];
    // W_F1 = 2000 * (25/30) = 1666.66
    // W_F2 = -500 * (15/30) = -250
    // W_F3 = 1000 * (5/30) = 166.66
    // W_F_Total = 1583.33
    // Denominador = 10000 + 1583.33 = 11583.33
    
    // NetFlows = 2000 - 500 + 1000 = 2500
    // Numerador = 13500 - 10000 - 2500 = 1000
    // Rendimiento = 1000 / 11583.33 = 8.63%

    const result = calculateModifiedDietz(10000, 13500, cashFlows, 30);
    expect(result).toBeCloseTo(8.633, 2);
  });

  it('Flash Crash (Valor Cero): Caída catastrófica tolerada', () => {
    // Escenario: 10000 -> 0.
    const result = calculateModifiedDietz(10000, 0, [], 31);
    expect(result).toBe(-100);
  });

  it('Liquidez Negativa (Margen): Operando con cuentas en deuda o apalancamiento neto negativo', () => {
    // Escenario: El usuario tiene -5000€ (Start) -> -4000€ (End) por plusvalías orgánicas (no flujos).
    // Antes, la división entre denominador negativo daría -20% en vez de +20%.
    // Con la cura de Math.abs(denominator), debe dar +20% reflejando mejora patrimonial.
    
    // Numerador = -4000 - (-5000) - 0 = 1000
    // Denominador Absoluto = |-5000| = 5000
    // Rendimiento = 20%
    const result = calculateModifiedDietz(-5000, -4000, [], 30);
    expect(result).toBeCloseTo(20, 2);

    // Empeoramiento patrimonial de deuda: -5000 -> -6000
    const resultLose = calculateModifiedDietz(-5000, -6000, [], 30);
    expect(resultLose).toBeCloseTo(-20, 2);
  });

  it('División por Estricto Cero produce 0% sin arrojar Infinity', () => {
    const result = calculateModifiedDietz(0, 0, [], 30);
    expect(result).toBe(0);
  });

});
