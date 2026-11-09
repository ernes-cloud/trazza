import { describe, it, expect, vi } from 'vitest';
import { planAssetPriceWrites, writeAssetPrices } from './assetPrices.js';

const symbolFor = (t) => (t && !/\s/.test(t) ? t : null);
const pos = (asset) => ({ quantity: 1, assets: { asset_class: 'Stock', ...asset } });

describe('planAssetPriceWrites', () => {
  it('escribe el precio de la cotización en la divisa del asset', () => {
    const quotes = new Map([['GOOGL', { current: 200, currency: 'USD' }]]);
    const { writes } = planAssetPriceWrites(
      [pos({ id: 'a1', ticker: 'GOOGL', currency: 'EUR', current_price: 170 })],
      quotes, { EUR: 1, USD: 0.9 }, symbolFor,
    );
    expect(writes).toEqual([{ assetId: 'a1', ticker: 'GOOGL', price: 180 }]);
  });

  it('sin el tipo de cambio de una de las dos divisas no escribe (no guarda USD como EUR)', () => {
    const quotes = new Map([['GOOGL', { current: 200, currency: 'USD' }]]);
    const { writes } = planAssetPriceWrites(
      [pos({ id: 'a1', ticker: 'GOOGL', currency: 'EUR', current_price: 170 })],
      quotes, { EUR: 1 }, symbolFor,
    );
    expect(writes).toEqual([]);
  });

  it('frena un desplome (÷100) y lo reporta', () => {
    const quotes = new Map([['VUAA.L', { current: 1.11, currency: 'USD' }]]);
    const { writes, implausible } = planAssetPriceWrites(
      [pos({ id: 'a1', ticker: 'VUAA.L', currency: 'USD', current_price: 111.2 })],
      quotes, { EUR: 1, USD: 0.9 }, symbolFor,
    );
    expect(writes).toEqual([]);
    expect(implausible).toEqual([{ assetId: 'a1', ticker: 'VUAA.L', stored: 111.2, price: 1.11 }]);
  });

  it('una subida grande sí pasa (cura un precio corrompido a la baja)', () => {
    const quotes = new Map([['VUAA.L', { current: 111.2, currency: 'USD' }]]);
    const { writes } = planAssetPriceWrites(
      [pos({ id: 'a1', ticker: 'VUAA.L', currency: 'USD', current_price: 1.11 })],
      quotes, {}, symbolFor,
    );
    expect(writes.map((w) => w.price)).toEqual([111.2]);
  });

  it('un asset compartido por varias posiciones se escribe una vez; liquidez y sin cotización, nunca', () => {
    const quotes = new Map([['MSFT', { current: 400, currency: 'USD' }], ['CASH_EUR', { current: 5, currency: 'EUR' }]]);
    const { writes } = planAssetPriceWrites([
      pos({ id: 'a1', ticker: 'MSFT', currency: 'USD', current_price: 390 }),
      pos({ id: 'a1', ticker: 'MSFT', currency: 'USD', current_price: 390 }),
      pos({ id: 'c1', ticker: 'CASH_EUR', currency: 'EUR', current_price: 1, asset_class: 'Cash' }),
      pos({ id: 'c2', ticker: 'EUR', currency: 'EUR', current_price: 1, asset_class: 'cash' }),
      pos({ id: 'f1', ticker: 'FONDO MONETARIO (EUR)', currency: 'EUR', current_price: 10 }),
      pos({ id: 'z1', ticker: 'NOPE', currency: 'USD', current_price: 10 }),
    ], quotes, {}, symbolFor);
    expect(writes).toEqual([{ assetId: 'a1', ticker: 'MSFT', price: 400 }]);
  });

  it('ignora cotizaciones a 0, negativas o no finitas', () => {
    const quotes = new Map([
      ['A', { current: 0, currency: 'USD' }],
      ['B', { current: -3, currency: 'USD' }],
      ['C', { current: Infinity, currency: 'USD' }],
      ['D', { current: NaN, currency: 'USD' }],
    ]);
    const positions = ['A', 'B', 'C', 'D'].map((t) => pos({ id: t, ticker: t, currency: 'USD', current_price: 10 }));
    expect(planAssetPriceWrites(positions, quotes, {}, symbolFor).writes).toEqual([]);
  });
});

describe('writeAssetPrices', () => {
  it('cuenta escritas, rechazadas por el guard SQL (false) y fallidas', async () => {
    const results = [
      { data: true, error: null },
      { data: false, error: null },
      { data: null, error: { message: 'boom' } },
    ];
    const rpc = vi.fn(async () => results.shift());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await writeAssetPrices({ rpc }, [
      { assetId: 'a', ticker: 'A', price: 1 },
      { assetId: 'b', ticker: 'B', price: 2 },
      { assetId: 'c', ticker: 'C', price: 3 },
    ]);
    warn.mockRestore();
    expect(out).toEqual({ written: 1, rejected: 1, failed: 1 });
    expect(rpc).toHaveBeenCalledWith('update_asset_market_data', { p_asset_id: 'a', p_current_price: 1 });
  });
});
