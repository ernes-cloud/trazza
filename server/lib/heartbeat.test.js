import { describe, it, expect } from 'vitest';
import { isHealthySnapshotRun, isHealthyWeeklyRun } from './heartbeat.js';

describe('isHealthySnapshotRun', () => {
  it('el caso real del fallo: 0 de 44 cotizaciones NO es sano', () => {
    expect(isHealthySnapshotRun({ users: 8, upserted: 8, tickers: 44, quotesResolved: 0 })).toBe(false);
  });

  it('todas o la mayoría resueltas es sano', () => {
    expect(isHealthySnapshotRun({ tickers: 50, quotesResolved: 50 })).toBe(true);
    expect(isHealthySnapshotRun({ tickers: 50, quotesResolved: 25 })).toBe(true);
  });

  it('menos de la mitad no', () => {
    expect(isHealthySnapshotRun({ tickers: 50, quotesResolved: 24 })).toBe(false);
  });

  it('un error, un skip o la ausencia de resumen no son sanos', () => {
    expect(isHealthySnapshotRun({ error: 'upsert failed', tickers: 10, quotesResolved: 10 })).toBe(false);
    expect(isHealthySnapshotRun({ skipped: true })).toBe(false);
    expect(isHealthySnapshotRun(undefined)).toBe(false);
  });

  it('sin nada que cotizar es sano (no hay fallo)', () => {
    expect(isHealthySnapshotRun({ users: 0, tickers: 0 })).toBe(true);
  });
});

describe('isHealthyWeeklyRun', () => {
  it('fuera de la ventana del lunes no cuenta como ejecución', () => {
    expect(isHealthyWeeklyRun({ skipped: 'outside window' })).toBe(false);
  });

  it('pasada sin fallos es sana aunque salte usuarios (skipped NUMÉRICO) o no envíe a nadie', () => {
    expect(isHealthyWeeklyRun({ users: 6, sent: 4, skipped: 2, failed: 0 })).toBe(true);
    expect(isHealthyWeeklyRun({ users: 0 })).toBe(true);
  });

  it('"already running" tampoco cuenta como ejecución', () => {
    expect(isHealthyWeeklyRun({ skipped: 'already running' })).toBe(false);
  });

  it('un envío fallido no es sano', () => {
    expect(isHealthyWeeklyRun({ users: 6, sent: 5, failed: 1 })).toBe(false);
  });
});
