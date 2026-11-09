import { describe, it, expect } from 'vitest';
import { getFundExposure, FUND_REGIONS, FUND_SECTORS, MULTI_CURRENCY } from './fundExposure';

// The 9 real MyInvestor cartera funds as they exist in the assets table
// (tickers/names from the reported portfolio — the donut showed them as
// 100% EUR and Europa/Luxembourg by domicile).
describe('getFundExposure — real MyInvestor cartera funds', () => {
  it('iShares US Index → US equity in USD', () => {
    expect(getFundExposure({ ticker: '0P0001XF42.F', company_name: 'iShares US Index (IE) S Acc EUR' }))
      .toEqual({ region: FUND_REGIONS.NORTH_AMERICA, currency: 'USD', sector: FUND_SECTORS.EQUITY });
  });

  it('iShares Screened Global Corp Bond EUR Hedged → GLOBAL corp bond, EUR (hedged)', () => {
    expect(getFundExposure({ ticker: '0P0001JAFO.F', company_name: 'iShares Scrn Gl Corp Bd Idx D EUR H A' }))
      .toEqual({ region: FUND_REGIONS.GLOBAL, currency: 'EUR', sector: FUND_SECTORS.BOND_CORP });
  });

  it('Vanguard U.S. Govt Bond € Hedged → US govt bond, EUR (hedged)', () => {
    expect(getFundExposure({ ticker: '0P00000W6H.F', company_name: 'Vanguard U.S. Govt Bd Idx € H Acc' }))
      .toEqual({ region: FUND_REGIONS.NORTH_AMERICA, currency: 'EUR', sector: FUND_SECTORS.BOND_GOVT });
  });

  it('Vanguard 20+ Yr € Treasury → eurozone govt bond in EUR (not hedge-tagged)', () => {
    expect(getFundExposure({ ticker: '0P0000CV2T.F', company_name: 'Vanguard 20+ Yr € Trs Idx € Acc' }))
      .toEqual({ region: FUND_REGIONS.EUROPE, currency: 'EUR', sector: FUND_SECTORS.BOND_GOVT });
  });

  it('Fidelity MSCI Europe → Europe equity in EUR', () => {
    expect(getFundExposure({ ticker: '0P0001CJGN.F', company_name: 'Fidelity MSCI Europe Index Fund' }))
      .toEqual({ region: FUND_REGIONS.EUROPE, currency: 'EUR', sector: FUND_SECTORS.EQUITY });
  });

  it('iShares Emerging Markets → EM equity, multi-currency basket', () => {
    expect(getFundExposure({ ticker: '0P0001XF3Z.F', company_name: 'iShares EmergMkts Idx (IE) S Acc EUR' }))
      .toEqual({ region: FUND_REGIONS.EMERGING, currency: MULTI_CURRENCY, sector: FUND_SECTORS.EQUITY });
  });

  it('Fidelity MSCI Japan → Asia-Pacific equity in JPY', () => {
    expect(getFundExposure({ ticker: 'FEPA.MU', company_name: 'Fidelity Ucits II Icav - Fidelity Msci Japan Index Fund' }))
      .toEqual({ region: FUND_REGIONS.ASIA_PACIFIC, currency: 'JPY', sector: FUND_SECTORS.EQUITY });
  });

  it('BGIF EM Govt Bond (unparseable name) → curated by ISIN embedded in the ticker', () => {
    expect(getFundExposure({ ticker: 'LU1811365292.LU', company_name: 'Blac Glo iEMGBIFL' }))
      .toEqual({ region: FUND_REGIONS.EMERGING, currency: 'USD', sector: FUND_SECTORS.BOND_GOVT });
  });

  it('Fidelity Asia Pacific ex Japan → Asia-Pacific, multi-currency (ex-japan wins over japan)', () => {
    expect(getFundExposure({ ticker: 'FEP0.MU', company_name: 'Fidelity Ucits Ii Icav - Fidelity Msci Asia Pacific Ex Japan Index Fund' }))
      .toEqual({ region: FUND_REGIONS.ASIA_PACIFIC, currency: MULTI_CURRENCY, sector: FUND_SECTORS.EQUITY });
  });
});

describe('getFundExposure — curated symbol map (active funds with opaque names)', () => {
  it('Gestión Value A FI → global equity, multi-currency (curated by Yahoo symbol)', () => {
    expect(getFundExposure({ ticker: '0P00019ORF.F', company_name: 'Gestión Value A FI' }))
      .toEqual({ region: FUND_REGIONS.GLOBAL, currency: MULTI_CURRENCY, sector: FUND_SECTORS.EQUITY });
  });
});

describe('getFundExposure — curated ISIN map', () => {
  it('resolves via the isin column when present', () => {
    expect(getFundExposure({ ticker: '0P0001CJGN.F', company_name: 'whatever', isin: 'IE00BYX5MD61' }))
      .toEqual({ region: FUND_REGIONS.EUROPE, currency: 'EUR', sector: FUND_SECTORS.EQUITY });
  });

  it('MyInvestor broker names (no ISIN) resolve via name rules', () => {
    expect(getFundExposure({ ticker: '0P0001XYZ9.F', company_name: 'BGIF EM MKT GOVER BOND INDEX D' }))
      .toEqual({ region: FUND_REGIONS.EMERGING, currency: 'USD', sector: FUND_SECTORS.BOND_GOVT });
    expect(getFundExposure({ ticker: '0P0001ABC1.F', company_name: 'FIDELITY MSCI PACFC EXJAPN IDX' }))
      .toEqual({ region: FUND_REGIONS.ASIA_PACIFIC, currency: MULTI_CURRENCY, sector: FUND_SECTORS.EQUITY });
  });
});

describe('getFundExposure — must NOT classify non-funds or unknowns', () => {
  it('returns null for plain stocks', () => {
    expect(getFundExposure({ ticker: 'AAPL', company_name: 'Apple Inc.' })).toBeNull();
    // 'US' inside a stock-ish name without any fund token
    expect(getFundExposure({ ticker: 'MU', company_name: 'Micron Technology, Inc.' })).toBeNull();
  });

  it('returns null for crypto tickers', () => {
    expect(getFundExposure({ ticker: 'BTC-USD', company_name: 'Bitcoin USD' })).toBeNull();
  });

  it('returns null when a fund name has no recognizable region', () => {
    expect(getFundExposure({ ticker: '0P00009999.F', company_name: 'Umbrella Fund Class A Acc' })).toBeNull();
  });

  it('returns null on missing input', () => {
    expect(getFundExposure(null)).toBeNull();
    expect(getFundExposure({ ticker: '', company_name: '' })).toBeNull();
  });

  it('share-class "Acc EUR" suffix alone never implies Europe', () => {
    expect(getFundExposure({ ticker: '0P00008888.F', company_name: 'Some Sector Index Acc EUR' })).toBeNull();
  });
});

describe('getFundExposure — fondos de MyInvestor guardados en euros invertidos', () => {
  // Desde 2026-10-03 un fondo que no se pudo convertir a participaciones se
  // guarda como "NOMBRE [importe] (EUR)". Sin recortar la marca, los fondos que
  // solo se clasifican por nombre perdían su clasificación (el ESG quedaba en
  // null y el Vanguard US Govt, cubierto a euros, pasaba a contar como USD).
  const FONDOS = [
    'VANGUARD 20', 'FIDELITY MSCI EUROPE INDEX P A', 'BGIF EM MKT GOVER BOND INDEX D',
    'VANGUARD US GOVERNMENT BD INDE', 'FIDELITY MSCI PACFC EXJAPN IDX', 'FIDELITY MSCI JAPAN INDEX P AC',
    'ISHARES ESG SCREENED GLB CORP', 'ISHARES US INDEX FUND IE S EUR', 'ISHARES EMERGING MARKETS INDEX',
  ];

  it.each(FONDOS)('%s se clasifica igual con y sin la marca [importe]', (n) => {
    const conParticipaciones = getFundExposure({ ticker: `${n} (EUR)`, company_name: n, isin: '', currency: 'EUR' });
    const enEuros = getFundExposure({ ticker: `${n} [importe] (EUR)`, company_name: n, isin: '', currency: 'EUR' });
    expect(conParticipaciones).not.toBeNull();
    expect(enEuros).toEqual(conParticipaciones);
  });

  it('las clases que usa MyInvestor tienen exposición por ISIN', () => {
    expect(getFundExposure({ ticker: '0P0001XF3Z.F', isin: 'IE000QAZP7L2' })?.region).toBe('EMERGING');
    expect(getFundExposure({ ticker: '0P0001XF42.F', isin: 'IE000N4ZYX28' })?.region).toBe('NORTH_AMERICA');
    expect(getFundExposure({ ticker: '0P0001JAFO.F', isin: 'IE00BJN4RG66' })).toMatchObject({ currency: 'EUR', sector: 'FUND_BOND_CORP' });
  });
});
