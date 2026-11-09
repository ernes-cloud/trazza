import { describe, it, expect } from 'vitest';
import { resolveTicker, strictResolveTicker } from './tickerMap';

// Regresión del bug reportado: el usuario introduce "AMZ.XGAT" (Amazon en Tradegate,
// código MIC ISO 10383) y el activo nunca carga precio — Yahoo Finance solo entiende
// sus propios sufijos (.DE, .PA, .MC…), no códigos MIC. resolveTicker debe traducir
// el sufijo MIC al sufijo Yahoo equivalente (Tradegate/Gettex no existen en Yahoo →
// proxy Xetra .DE: mismo instrumento, misma cotización EUR).

describe('resolveTicker — normalización de sufijos MIC', () => {
  it('AMZ.XGAT (Tradegate) → AMZ.DE (el bug reportado)', () => {
    expect(resolveTicker('AMZ.XGAT')).toBe('AMZ.DE');
  });

  it('códigos alternativos de Tradegate/Gettex también → .DE', () => {
    expect(resolveTicker('AMZ.TGAT')).toBe('AMZ.DE');
    expect(resolveTicker('AMZ.XGRM')).toBe('AMZ.DE');
  });

  it('MIC alemán XETR → .DE aunque el símbolo base no esté en TICKER_MAP', () => {
    expect(resolveTicker('SAP.XETR')).toBe('SAP.DE');
  });

  it('MICs europeos principales → sufijo Yahoo', () => {
    expect(resolveTicker('SAN.XMAD')).toBe('SAN.MC');   // Madrid
    expect(resolveTicker('AIR.XPAR')).toBe('AIR.PA');   // París
    expect(resolveTicker('ASML.XAMS')).toBe('ASML.AS'); // Ámsterdam
    expect(resolveTicker('BARC.XLON')).toBe('BARC.L');  // Londres
    expect(resolveTicker('ENI.XMIL')).toBe('ENI.MI');   // Milán
  });

  it('MICs de EEUU → símbolo pelado (Yahoo no usa sufijo en NYSE/NASDAQ)', () => {
    expect(resolveTicker('AMZN.XNAS')).toBe('AMZN');
    expect(resolveTicker('KO.XNYS')).toBe('KO');
  });

  it('decoraciones de moneda/exchange se limpian antes de resolver', () => {
    expect(resolveTicker('AMZ.XGAT (EUR)')).toBe('AMZ.DE');
    // El formato [XGAT] lo elimina el stripping de corchetes preexistente
    // (queda 'AMZ' → alias del mapa), NO la traducción MIC nueva.
    expect(resolveTicker('AMZ [XGAT] (EUR)')).toBe('AMZ.DE');
  });

  it('un sufijo de 4 letras desconocido NO se toca (conservador)', () => {
    expect(resolveTicker('FOO.XZZZ')).toBe('FOO.XZZZ');
  });

  it('no rompe la resolución existente', () => {
    expect(resolveTicker('AAPL')).toBe('AAPL');               // sin sufijo
    expect(resolveTicker('MC.PA')).toBe('MC.PA');             // sufijo Yahoo legítimo
    expect(resolveTicker('US0231351067')).toBe('AMZN');       // ISIN
    expect(resolveTicker('AMZ')).toBe('AMZ.DE');              // alias corto
    expect(resolveTicker('ATCO-A.ST')).toBe('ATCO-A.ST');     // sufijo nórdico 2 letras
    expect(resolveTicker('BTC-EUR')).toBe('BTC-EUR');         // cripto
  });
});

describe('strictResolveTicker — solo mapeos explícitos', () => {
  it('AMZ.XGAT → AMZ.DE porque la base AMZ está explícitamente mapeada', () => {
    expect(strictResolveTicker('AMZ.XGAT')).toBe('AMZ.DE');
  });

  it('traducción MIC pura sin hit en TICKER_MAP → null (el mapa dinámico conserva prioridad)', () => {
    expect(strictResolveTicker('SAP.XETR')).toBeNull();
  });

  it('entrada sin mapeo → null (comportamiento existente)', () => {
    expect(strictResolveTicker('FOO.BAR')).toBeNull();
    expect(strictResolveTicker('AAPL')).toBeNull();
  });
});
