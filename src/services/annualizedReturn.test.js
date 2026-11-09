import { describe, it, expect } from 'vitest';
import { firstInvestedDate, annualizeReturn, windowYears, annualizedTwrFromSeries } from './performanceService';

/* La anualizada se hundía porque la ventana arrancaba en el primer APUNTE (un
   ingreso de efectivo, una comisión, un traspaso) y no en el primer día con
   dinero en mercado. El TWR no lo nota —la cadena multiplica por 1 mientras no
   hay activos— pero la ventana es el divisor, así que cada mes muerto rebaja la
   cifra anual sin que nada en la pantalla lo explique. */

describe('firstInvestedDate', () => {
  it('salta los días de sólo-caja del principio de la serie', () => {
    const series = [
      { date: '2024-01-08', value: 0 },   // ingreso de efectivo
      { date: '2024-05-02', value: 0 },   // comisión de custodia
      { date: '2024-10-06', value: 1200 }, // primera compra
      { date: '2024-10-07', value: 1210 },
    ];
    expect(firstInvestedDate(series)).toBe('2024-10-06');
  });

  it('acepta puntos que sólo traen `name` (la serie del gráfico)', () => {
    expect(firstInvestedDate([{ name: '2024-03-01', value: 0 }, { name: '2024-03-02', value: 50 }]))
      .toBe('2024-03-02');
  });

  it('devuelve null si nunca hubo posiciones, y tolera entradas vacías', () => {
    expect(firstInvestedDate([{ date: '2024-01-01', value: 0 }])).toBeNull();
    expect(firstInvestedDate([])).toBeNull();
    expect(firstInvestedDate()).toBeNull();
  });

  it('no confunde un valor negativo con estar invertido', () => {
    expect(firstInvestedDate([{ date: '2024-01-01', value: -10 }])).toBeNull();
  });
});

describe('windowYears', () => {
  it('mide la ventana del caso reportado', () => {
    expect(windowYears('2024-10-06', '2026-09-20')).toBeCloseTo(1.955, 3);
  });

  it('es la MISMA ventana que usa la anualizada (la UI enseña una, no una parecida)', () => {
    const years = windowYears('2024-10-06', '2026-09-20');
    const cagr = annualizeReturn(60.44, '2024-10-06', '2026-09-20');
    expect((1 + cagr / 100) ** years - 1).toBeCloseTo(0.6044, 6);
  });

  it('descarta ventanas sin sentido', () => {
    expect(windowYears(null)).toBeNull();
    expect(windowYears('no-es-una-fecha')).toBeNull();
    expect(windowYears('2026-01-01', '2024-01-01')).toBeNull();
    expect(windowYears('2026-01-01', '2026-01-01')).toBeNull();
  });
});

describe('annualizeReturn', () => {
  it('compone, no promedia: +60,44% en 1,95 años son +27,36% anual, no +30,2%', () => {
    // El caso reportado: TWR +60,44% con la primera compra el 6-oct-2024.
    const cagr = annualizeReturn(60.44, '2024-10-06', '2026-09-20');
    expect(cagr).toBeCloseTo(27.36, 1);
    // Dividir entre los años (60,44 / 1,96 ≈ 30,8) siempre da de más, porque
    // ignora que el segundo año compone sobre el primero.
    expect(cagr).toBeLessThan(60.44 / 1.9583);
  });

  it('la cifra anualizada, compuesta por los años de la ventana, reconstruye el acumulado', () => {
    const years = (new Date('2026-09-20') - new Date('2024-10-06')) / (365.25 * 24 * 3600 * 1000);
    const cagr = annualizeReturn(60.44, '2024-10-06', '2026-09-20');
    expect((1 + cagr / 100) ** years - 1).toBeCloseTo(0.6044, 6);
  });

  it('una ventana que arranca en el apunte de caja rebaja la anualizada (la regresión)', () => {
    const conCaja = annualizeReturn(60.44, '2024-01-08', '2026-09-20');
    const invertido = annualizeReturn(60.44, '2024-10-06', '2026-09-20');
    expect(conCaja).toBeCloseTo(19.1, 1);   // lo que se veía en pantalla
    expect(invertido).toBeGreaterThan(conCaja);
  });

  it('un año natural deja el acumulado prácticamente intacto', () => {
    // No es exacto a propósito: la ventana se mide en años JULIANOS (365,25 días,
    // que es lo que promedian los bisiestos), así que 365 días naturales son
    // 0,9993 años y el +12% sale como +12,009%.
    expect(annualizeReturn(12, '2025-01-01', '2026-01-01')).toBeCloseTo(12, 1);
  });

  it('anualiza también las pérdidas', () => {
    expect(annualizeReturn(-19, '2024-09-20', '2026-09-20')).toBeCloseTo(-10, 1);
  });

  it('no anualiza tramos de menos de medio año — sería ruido multiplicado', () => {
    expect(annualizeReturn(8, '2026-07-01', '2026-09-20')).toBeNull();
    expect(annualizeReturn(8, '2026-03-01', '2026-09-20')).not.toBeNull();
  });

  it('respeta un mínimo de años distinto', () => {
    expect(annualizeReturn(8, '2026-07-01', '2026-09-20', { minYears: 0.1 })).not.toBeNull();
  });

  it('devuelve null ante entradas que no describen nada', () => {
    expect(annualizeReturn(null, '2024-01-01', '2026-01-01')).toBeNull();
    expect(annualizeReturn(10, null, '2026-01-01')).toBeNull();
    expect(annualizeReturn(10, 'no-es-una-fecha', '2026-01-01')).toBeNull();
    expect(annualizeReturn(NaN, '2024-01-01', '2026-01-01')).toBeNull();
    expect(annualizeReturn(10, '2026-01-01', '2024-01-01')).toBeNull(); // ventana invertida
    expect(annualizeReturn(-100, '2024-01-01', '2026-01-01')).toBeNull(); // sin ritmo que describir
  });
});

describe('annualizedTwrFromSeries — la cifra que precarga la calculadora', () => {
  // Regresión 2026-10-02: DashboardLayout anualizaba valor/coste entre la
  // PRIMERA y la ÚLTIMA compra (no hasta hoy), así que a quien dejó de comprar
  // hace un año le inflaba el CAGR. Ahora es la MISMA cifra que la pantalla de
  // brokers: TWR acumulado del último punto, desde el primer día invertido.
  it('anualiza el TTWROR del último punto desde el primer día con valor > 0', () => {
    const series = [
      { date: '2023-01-01', value: 0, ttwror: 0 },          // ingreso de caja, aún sin invertir
      { date: '2024-01-01', value: 1000, ttwror: 0 },
      { date: '2026-01-01', value: 1500, ttwror: 21 },
    ];
    // 2 años desde el primer día invertido → 1,21^(1/2) − 1 = 10 %
    expect(annualizedTwrFromSeries(series)).toBeCloseTo(10, 1);
  });

  it('cae a cumulativeReturn en series antiguas sin ttwror', () => {
    const series = [{ date: '2024-01-01', value: 1, cumulativeReturn: 0 }, { date: '2026-01-01', value: 2, cumulativeReturn: 21 }];
    expect(annualizedTwrFromSeries(series)).toBeCloseTo(10, 1);
  });

  it('con menos de 6 meses invertido no da cifra (no se anualiza ruido)', () => {
    const series = [{ date: '2026-01-01', value: 1, ttwror: 0 }, { date: '2026-04-01', value: 1, ttwror: 8 }];
    expect(annualizedTwrFromSeries(series)).toBeNull();
  });

  it('sin serie, null', () => {
    expect(annualizedTwrFromSeries([])).toBeNull();
    expect(annualizedTwrFromSeries(null)).toBeNull();
  });
});
