import React, { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FileSpreadsheet, Download, AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { buildTaxReport, taxReportToCsv } from '@/services/taxReportService';
import { collectFxNeeds, preloadTaxRates } from '@/services/tax/fxByDate';
import { currencyService } from '@/services/currencyService';
import { formatNumber, formatMoney } from '@/lib/formatters';

const getRateOnOrBefore = (from, to, date) => currencyService.getHistoricalRateOnOrBefore(from, to, date);

/**
 * Informe fiscal anual — consumes the SAME processed rows the brokers screen
 * tables show (salesWithPL / dividends / commissions), grouped by fiscal year
 * by taxReportService. Export: Spanish-Excel CSV (';' + comma decimals).
 *
 * Tipos de cambio: al abrirse precarga el tipo del día de cada operación (y de
 * cada lote FIFO) con tax/fxByDate; hasta entonces no pinta cifras. Lo que se
 * queda sin tipo no entra en los totales y se avisa (nunca el cambio de hoy).
 * Una venta sin compra de NINGUNA acción queda fuera y se avisa; con PARTE
 * sin compra computa la parte conocida y las unidades sin coste se listan
 * («Unidades vendidas sin coste»), fuera de los totales.
 *
 * Regla de los dos meses: con `buys` (processedImportData.buys) el informe la
 * aplica con el núcleo compartido tax/twoMonthRule; aquí solo se pinta lo que
 * devuelve (aplazadas, integradas, pendientes y aviso sin ISIN). El FIFO del
 * informe es por ISIN y no el de la pantalla (ISIN+divisa): con mercados
 * mezclados pueden diferir (docs/claude/finance.md).
 */
export default function TaxReportDialog({
  isOpen,
  onOpenChange,
  sales = [],
  buys = [],
  dividends = [],
  commissions = [],
  preferredCurrency = 'EUR',
  maskMoney = (s) => s,
}) {
  const { t } = useTranslation();

  const needs = useMemo(
    () => collectFxNeeds({ sales, buys, dividends, commissions, preferredCurrency }),
    [sales, buys, dividends, commissions, preferredCurrency]
  );
  const needsKey = useMemo(() => needs.map(n => `${n.currency}|${n.date}`).join(','), [needs]);

  // { status: 'loading'|'ready'|'error', table, key } — `key` ata la tabla a
  // las necesidades con las que se cargó, para no pintar con una vieja.
  const [fx, setFx] = useState({ status: 'loading', table: {}, key: null });
  useEffect(() => {
    if (!isOpen) return undefined;
    const key = `${preferredCurrency}#${needsKey}`;
    if (needs.length === 0) {
      setFx({ status: 'ready', table: {}, key });
      return undefined;
    }
    let cancelled = false;
    setFx({ status: 'loading', table: {}, key });
    preloadTaxRates(needs, { getRate: getRateOnOrBefore, preferredCurrency })
      .then(({ table }) => { if (!cancelled) setFx({ status: 'ready', table, key }); })
      .catch((error) => {
        console.error('TaxReportDialog: no se pudieron precargar los tipos de cambio', error);
        if (!cancelled) setFx({ status: 'error', table: {}, key });
      });
    return () => { cancelled = true; };
    // needs ya está capturado por needsKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, needsKey, preferredCurrency]);

  const fxSettled = fx.key === `${preferredCurrency}#${needsKey}` && fx.status !== 'loading';
  const report = useMemo(
    () => buildTaxReport({ sales, buys, dividends, commissions, preferredCurrency, rates: fx.table }),
    [sales, buys, dividends, commissions, preferredCurrency, fx.table]
  );

  const [selectedYear, setSelectedYear] = useState(null);
  const year = selectedYear && report.years.includes(selectedYear)
    ? selectedYear
    : (report.years[0] || null);
  const data = year ? report.byYear[year] : null;

  const money = (v) => maskMoney(formatMoney(v, preferredCurrency));

  const handleExport = () => {
    if (!data) return;
    const labels = {
      title: t('tax_report.title'),
      summary: t('tax_report.summary'),
      gains: t('tax_report.gains'),
      losses: t('tax_report.losses'),
      net: t('tax_report.net'),
      dividendsReceived: t('tax_report.dividends_received'),
      withholding: t('tax_report.withholding'),
      fees: t('tax_report.fees'),
      proceeds: t('tax_report.proceeds'),
      acquisition: t('tax_report.acquisition'),
      salesSection: t('tax_report.sales_section'),
      dividendsSection: t('tax_report.dividends_section'),
      missingFxSection: t('tax_report.missing_fx_section'),
      date: t('tax_report.col_date'),
      asset: t('tax_report.col_asset'),
      quantity: t('tax_report.col_qty'),
      price: t('tax_report.col_price'),
      currency: t('tax_report.col_currency'),
      amount: t('tax_report.col_amount'),
      pnl: t('tax_report.col_pnl'),
      fxRate: t('tax_report.col_fx_rate'),
      fxSource: t('tax_report.col_fx_source'),
      note: t('tax_report.col_note'),
      kind: t('tax_report.col_kind'),
      fxDate: t('tax_report.col_fx_date'),
      reason: t('tax_report.col_reason'),
      missingFxNote: t('tax_report.missing_fx_note'),
      unreliableNote: t('tax_report.unreliable_note'),
      partialHistoryNote: t('tax_report.partial_history_note'),
      partialHistorySection: t('tax_report.partial_history_section'),
      missingShares: t('tax_report.col_missing_shares'),
      excludedProceeds: t('tax_report.col_excluded_proceeds'),
      deferred: t('tax_report.deferred'),
      released: t('tax_report.released'),
      stillDeferred: t('tax_report.still_deferred'),
      computable: t('tax_report.col_computable'),
      noIsinNote: t('tax_report.no_isin_note'),
      pendingSection: t('tax_report.pending_section'),
      pendingBuyDate: t('tax_report.pending_buy_date'),
      pendingRemaining: t('tax_report.pending_remaining'),
      pendingShares: t('tax_report.pending_shares'),
      pendingAmount: t('tax_report.pending_amount'),
      sources: {
        broker: t('tax_report.source_broker'),
        historical: t('tax_report.source_historical'),
        eur: t('tax_report.source_eur'),
      },
      reasons: {
        no_rate: t('tax_report.reason_no_rate'),
        no_date: t('tax_report.reason_no_date'),
      },
      kinds: {
        sale: t('tax_report.kind_sale'),
        dividend: t('tax_report.kind_dividend'),
        fee: t('tax_report.kind_fee'),
        withholding: t('tax_report.kind_withholding'),
      },
    };
    // BOM so Excel opens it as UTF-8 (tildes/€ intact)
    const csv = taxReportToCsv(data, year, labels, { pendingDeferred: report.pendingDeferred });
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trazza-fiscal-${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const summaryCard = (label, value, tone = 'neutral') => {
    const tones = {
      pos: 'text-emerald-600 dark:text-emerald-400',
      neg: 'text-red-600 dark:text-red-400',
      neutral: 'text-slate-900 dark:text-white',
    };
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-3">
        <p className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</p>
        <p className={`font-ledger text-lg font-bold tabular-nums ${tones[tone]}`}>{value}</p>
      </div>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            {t('tax_report.title')}
          </DialogTitle>
        </DialogHeader>

        {report.years.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400 py-6 text-center">
            {t('tax_report.empty')}
          </p>
        ) : !fxSettled ? (
          <p className="flex items-center justify-center gap-2 text-sm text-slate-600 dark:text-slate-400 py-6">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('tax_report.loading_rates')}
          </p>
        ) : (
          <div className="space-y-4">
            {/* Year selector */}
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                {t('tax_report.year_label')}
              </label>
              <select
                value={year}
                onChange={(e) => setSelectedYear(e.target.value)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm px-3 py-1.5"
              >
                {report.years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {summaryCard(t('tax_report.gains'), money(data.gains), 'pos')}
              {summaryCard(t('tax_report.losses'), money(data.losses), data.losses < 0 ? 'neg' : 'neutral')}
              {data.twoMonthRule && summaryCard(t('tax_report.deferred'), money(data.deferred))}
              {data.twoMonthRule && summaryCard(t('tax_report.released'), money(data.released), data.released > 0 ? 'neg' : 'neutral')}
              {summaryCard(t('tax_report.net'), money(data.net), data.net >= 0 ? 'pos' : 'neg')}
              {data.twoMonthRule && summaryCard(t('tax_report.still_deferred'), money(data.stillDeferred))}
              {/* Lo que pide la Renta por cada transmisión: valor de transmisión y de adquisición */}
              {summaryCard(t('tax_report.proceeds'), money(data.proceeds))}
              {summaryCard(t('tax_report.acquisition'), money(data.acquisition))}
              {summaryCard(t('tax_report.dividends_received'), money(data.dividendsReceived))}
              {/* Aparte de los gastos: para declarar, bruto y retención van por separado */}
              {summaryCard(t('tax_report.withholding'), money(data.withholding))}
              {summaryCard(t('tax_report.fees'), money(data.fees))}
              {summaryCard(t('tax_report.sales_count'), `${data.salesCount}`)}
            </div>
            {/* Con la regla (siempre desde aquí) las comisiones de compraventa van en los valores */}
            {data.twoMonthRule && (
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('tax_report.fees_note')}</p>
            )}

            {fx.status === 'error' && (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 p-3 text-sm text-red-700 dark:text-red-300">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{t('tax_report.rates_error')}</span>
              </div>
            )}

            {data.missingFxCount > 0 && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 p-3 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{t('tax_report.missing_fx_warning', { count: data.missingFxCount })}</span>
              </div>
            )}

            {data.noIsinCount > 0 && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 p-3 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{t('tax_report.no_isin_warning', { count: data.noIsinCount })}</span>
              </div>
            )}

            {data.partialHistoryCount > 0 && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 p-3 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{t('tax_report.partial_history_warning', { count: data.partialHistoryCount })}</span>
              </div>
            )}

            {data.unreliableCount > 0 && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 p-3 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{t('tax_report.unreliable_warning', { count: data.unreliableCount })}</span>
              </div>
            )}

            {/* Sales detail */}
            {data.sales.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {t('tax_report.sales_section')}
                </h3>
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-900/50 text-left">
                      <tr>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400">{t('tax_report.col_date')}</th>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400">{t('tax_report.col_asset')}</th>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400 text-right">{t('tax_report.col_qty')}</th>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400 text-right">{t('tax_report.col_pnl')}</th>
                        {data.twoMonthRule && (
                          <>
                            <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400 text-right">{t('tax_report.col_deferred')}</th>
                            <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400 text-right">{t('tax_report.col_released')}</th>
                            <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400 text-right">{t('tax_report.col_computable')}</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700/60">
                      {data.sales.map((s, i) => (
                        <tr key={`${s.isoDay}-${s.isin}-${i}`}>
                          <td className="px-3 py-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">{s.fecha}</td>
                          <td className="px-3 py-2 text-slate-900 dark:text-white">
                            {s.nombre}
                            {s.status !== 'ok' && (
                              <AlertTriangle className="w-3.5 h-3.5 inline ml-1.5 -mt-0.5 text-amber-500" />
                            )}
                            {s.status === 'partial_history' && s.profit != null && (
                              <span className="block text-xs text-amber-600 dark:text-amber-400" title={t('tax_report.partial_history_note')}>
                                {t('tax_report.partial_history_row', { shares: formatNumber(s.missingShares, 0, 4) })}
                              </span>
                            )}
                            {(s.blockedBy || []).map((bb, j) => (
                              <span key={j} className="block text-xs text-slate-500 dark:text-slate-400">
                                {t('tax_report.blocked_by', { date: bb.fecha })}
                              </span>
                            ))}
                            {s.status !== 'ok' && s.released > 0 && (
                              <span className="block text-xs text-amber-600 dark:text-amber-400">
                                {t('tax_report.released_row', { amount: money(s.released) })}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">{formatNumber(s.cantidad, 0, 4)}</td>
                          {s.profit == null ? (
                            <td
                              colSpan={data.twoMonthRule ? 4 : 1}
                              className="px-3 py-2 text-right text-xs text-amber-600 dark:text-amber-400"
                              title={s.status === 'missing_fx' ? t('tax_report.missing_fx_note') : t('tax_report.unreliable_note')}
                            >
                              {t('tax_report.not_computed')}
                            </td>
                          ) : (
                            <>
                              <td className={`px-3 py-2 text-right tabular-nums font-medium ${s.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                {money(s.profit)}
                              </td>
                              {data.twoMonthRule && (
                                <>
                                  <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">{s.deferred > 0 ? money(s.deferred) : '—'}</td>
                                  <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">{s.released > 0 ? money(-s.released) : '—'}</td>
                                  <td className={`px-3 py-2 text-right tabular-nums font-medium ${s.computable >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                    {money(s.computable)}
                                  </td>
                                </>
                              )}
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Unidades vendidas sin compra: su importe NO está en los totales, a la vista */}
            {(data.partialHistory || []).length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {t('tax_report.partial_history_section')}
                </h3>
                <div className="overflow-x-auto rounded-lg border border-amber-200 dark:border-amber-800/40">
                  <table className="w-full text-sm">
                    <thead className="bg-amber-50 dark:bg-amber-900/20 text-left">
                      <tr>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400">{t('tax_report.col_date')}</th>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400">{t('tax_report.col_asset')}</th>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400">ISIN</th>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400 text-right">{t('tax_report.col_missing_shares')}</th>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400 text-right">{t('tax_report.col_excluded_proceeds')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700/60">
                      {data.partialHistory.map((ph, i) => (
                        <tr key={`${ph.isoDay}-${ph.isin}-${i}`}>
                          <td className="px-3 py-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">{ph.fecha}</td>
                          <td className="px-3 py-2 text-slate-900 dark:text-white">{ph.nombre}</td>
                          <td className="px-3 py-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">{ph.isin}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">{formatNumber(ph.missingShares, 0, 4)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">{money(ph.excludedProceeds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.twoMonthRule && report.pendingDeferred.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  {t('tax_report.pending_section')}
                </h3>
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-900/50 text-left">
                      <tr>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400">{t('tax_report.pending_buy_date')}</th>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400">{t('tax_report.col_asset')}</th>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400 text-right">{t('tax_report.pending_shares')}</th>
                        <th className="px-3 py-2 font-semibold text-slate-600 dark:text-slate-400 text-right">{t('tax_report.pending_amount')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700/60">
                      {report.pendingDeferred.map((p, i) => (
                        <tr key={`${p.isoDay}-${p.isin}-${i}`}>
                          <td className="px-3 py-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">{p.fecha}</td>
                          <td className="px-3 py-2 text-slate-900 dark:text-white">{p.nombre}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">{formatNumber(p.deferredShares, 0, 4)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">{money(p.deferredAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.twoMonthRule && (
              <p className="text-xs text-slate-500 dark:text-slate-500">
                {t('tax_report.two_month_explainer')}
              </p>
            )}

            <p className="text-xs text-slate-500 dark:text-slate-500">
              {t('tax_report.disclaimer')}
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          {data && fxSettled && (
            <Button onClick={handleExport} className="gap-2">
              <Download className="w-4 h-4" />
              {t('tax_report.export_csv')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
