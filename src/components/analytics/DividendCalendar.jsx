import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { dividendService } from '@/services/dividendService';
import { resolveTicker } from '@/lib/tickerMap';
import { isCashPosition } from '@/lib/positionKind';
import { runPooled } from '@/lib/asyncPool';
import { Loader2, CalendarDays, Clock, TrendingUp } from 'lucide-react';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { usePrivacyMode } from '@/contexts/PrivacyModeContext';
import { formatNumber } from '@/lib/formatters';
import { projectedPerShareThisYear } from '@/services/dividendProjection';

const CURRENCY_SYMBOLS = {
    'USD': '$', 'EUR': '€', 'GBP': '£', 'JPY': '¥', 'CHF': 'Fr', 'CAD': 'C$',
    'AUD': 'A$', 'BRL': 'R$', 'CNY': '¥', 'HKD': 'HK$', 'SGD': 'S$', 'NZD': 'NZ$',
};
const getCurrencySymbol = (code) => CURRENCY_SYMBOLS[(code || '').toUpperCase()] || (code || '$');

const DividendCalendar = ({ positions = [], currency = 'USD', exchangeRates = {} }) => {
    const { t, i18n } = useTranslation();
    const { user } = useSupabaseAuth();
    const { privacyMode } = usePrivacyMode();
    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [annualSummary, setAnnualSummary] = useState({ prevYear: null, thisYear: null, nextYear: null, realizedFailed: false });

    const getRate = (cur) => (!cur || cur === currency) ? 1 : (exchangeRates[cur] || 1);

    useEffect(() => {
        if (!positions.length) { setLoading(false); return; }

        const fetchAll = async () => {
            setLoading(true);
            const seen = new Set();
            const results = [];

            // Upcoming events: only currently-held positions (closed qty=0 rows stay in DB).
            // Historical totals below DO use all positions — dividends from sold stocks are real income.
            const invested = positions.filter(p => {
                const isCash = isCashPosition(p);
                return !isCash && parseFloat(p.quantity) > 0.0001;
            });

            // Pool, no ráfaga: Yahoo estrangula las ráfagas (ver lib/asyncPool).
            await runPooled(invested.map((p) => async () => {
                const ticker = resolveTicker(p.assets?.ticker);
                if (!ticker || seen.has(ticker)) return;
                seen.add(ticker);
                try {
                    const data = await dividendService.getDividend(ticker);
                    if (!data) return;
                    results.push({
                        ticker,
                        name: data.name || p.assets?.company_name || ticker,
                        exDate: data.exDate,
                        paymentDate: data.paymentDate,
                        amount: data.amount,
                        annualDividend: data.annualDividend,
                        quantity: parseFloat(p.quantity || 0),
                        currency: p.assets?.currency || 'USD',
                        isPredicted: data.isPredicted || false,
                    });
                } catch (e) {
                    console.warn(`DividendCalendar: ${ticker}`, e);
                }
            }));

            const now = new Date();
            results.sort((a, b) => {
                const aFut = new Date(a.exDate) >= now;
                const bFut = new Date(b.exDate) >= now;
                if (aFut && bFut) return new Date(a.exDate) - new Date(b.exDate);
                if (aFut) return -1;
                if (bFut) return 1;
                return new Date(b.exDate) - new Date(a.exDate);
            });

            setEvents(results);

            const thisYear = new Date().getFullYear();
            const prevYear = thisYear - 1;

            // Ritmo anual (próximos 12 meses) y lo que QUEDA de este año: son cosas
            // distintas; sumar el anual entero a lo cobrado inflaba la cifra del año.
            const forwardProjection = results.reduce((sum, ev) => {
                const rate = getRate(ev.currency);
                return sum + (ev.annualDividend || 0) * ev.quantity * rate;
            }, 0);
            const remainingThisYear = results.reduce((sum, ev) => (
                sum + projectedPerShareThisYear(ev) * ev.quantity * getRate(ev.currency)
            ), 0);

            // Fetch actual historical dividends to avoid discrepancies
            let prevYearTotal = 0;
            let currentYearRealized = 0;
            let realizedFailed = false;
            if (user) {
                try {
                    const positionIds = positions.map(p => p.id).filter(Boolean);
                    const brokerIds = [...new Set(positions.map(p => p.broker_id).filter(Boolean))];

                    const [{ data: dbTrans, error: dbTxError }, { data: allTxRows, error: allTxError }, { data: importedRows, error: importedError }] = await Promise.all([
                        // DB DIVIDEND transactions — filtered by position_id to respect broker selection
                        positionIds.length
                            ? supabase
                                .from('transactions')
                                .select('transaction_date, total_amount, transaction_currency, positions(assets(currency))')
                                .eq('transaction_type', 'DIVIDEND')
                                .in('position_id', positionIds)
                            : Promise.resolve({ data: [] }),
                        // ALL transaction position_ids — to detect "saved" brokers (any type, not
                        // just DIVIDEND: a saved broker may have buys in DB but its dividends
                        // only in the CSV JSON)
                        positionIds.length
                            ? supabase
                                .from('transactions')
                                .select('position_id')
                                .in('position_id', positionIds)
                            : Promise.resolve({ data: [] }),
                        // CSV imported data — filtered by broker_id to respect broker selection
                        positionIds.length && brokerIds.length
                            ? supabase
                                .from('imported_data')
                                .select('broker_id, transactions')
                                .eq('user_id', user.id)
                                .in('broker_id', brokerIds)
                            : Promise.resolve({ data: [] }),
                    ]);
                    const queryError = dbTxError || allTxError || importedError;
                    if (queryError) throw queryError;

                    // Same saved/unsaved split as Dashboard & CarteraPage: a broker whose CSV
                    // was confirmed lives in `transactions`; processing its imported_data JSON
                    // too would double-count every dividend.
                    const brokerByPositionId = Object.fromEntries(positions.map(p => [p.id, p.broker_id]));
                    const savedBrokerIdSet = new Set(
                        (allTxRows || []).map(r => brokerByPositionId[r.position_id]).filter(Boolean)
                    );

                    const processDivs = (divs, isCSV) => {
                        divs.forEach(t => {
                            const tDate = t.transaction_date || t.fecha;
                            if (!tDate) return;
                            
                            const parts = tDate.split('-');
                            let year = 0;
                            if (parts.length >= 3) {
                                if (parts[0].length === 4) year = parseInt(parts[0], 10);
                                else if (parts[2].length >= 4) year = parseInt(parts[2].substring(0, 4), 10);
                            }
                            if (!year) return;
                            
                            // DB rows: convert with the transaction's OWN currency (column), not the
                            // asset's listing currency — IBKR settles dividends in EUR even for USD
                            // stocks (same rule as portfolioHistory.computeHistoryTotals).
                            const cur = isCSV
                                ? (t.moneda || 'EUR')
                                : (t.transaction_currency || t.positions?.assets?.currency || 'EUR');
                            const rate = getRate(cur);
                            const amount = parseFloat(t.total_amount || t.total || 0) * rate;

                            if (year === prevYear) prevYearTotal += amount;
                            else if (year === thisYear) currentYearRealized += amount;
                        });
                    };

                    if (dbTrans) processDivs(dbTrans, false);
                    if (importedRows) {
                        const csvDivs = importedRows
                            .filter(r => !savedBrokerIdSet.has(r.broker_id))
                            .flatMap(r => (r.transactions || []).filter(t => (t.transaction_type === 'DIVIDEND' || t.type === 'DIVIDEND')));
                        processDivs(csvDivs, true);
                    }
                } catch (e) {
                    // Sin lo cobrado no se pinta un 0 € que parece real: la tarjeta dice "no disponible".
                    console.warn("Failed to fetch actual dividends", e);
                    realizedFailed = true;
                }
            }

            // El año que viene = ritmo actual. Antes era el anual ×1,05, un crecimiento inventado.
            setAnnualSummary({
                prevYear: realizedFailed ? null : prevYearTotal,
                thisYear: realizedFailed ? null : currentYearRealized + remainingThisYear,
                nextYear: forwardProjection,
                realizedFailed,
            });

            setLoading(false);
        };

        fetchAll();
    }, [positions, user, currency, exchangeRates]);

    const getDaysUntil = (dateStr) => {
        if (!dateStr) return null;
        return (new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24);
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '—';
        return new Date(dateStr).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' });
    };

    const formatCountdown = (days) => {
        if (days === null) return null;
        if (days < -1) return t('common.days_ago', { n: Math.abs(Math.floor(days)) });
        if (days < 0) return t('common.yesterday');
        if (days < 1) return t('common.today_label');
        if (days < 2) return t('common.tomorrow');
        return t('common.in_days', { n: Math.ceil(days) });
    };

    const getCardStyle = (days) => {
        if (days === null) return 'bg-slate-50 dark:bg-slate-900/30 border-slate-200 dark:border-slate-700/50';
        if (days < 0) return 'bg-slate-50 dark:bg-slate-900/30 border-slate-200 dark:border-slate-700/50';
        if (days <= 1) return 'bg-red-50 dark:bg-red-900/10 border-red-300 dark:border-red-700/40';
        if (days <= 7) return 'bg-orange-50 dark:bg-orange-900/10 border-orange-200 dark:border-orange-700/30';
        return 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800/30';
    };

    const UrgencyBadge = ({ days }) => {
        if (days === null || days < 0) return null;
        if (days <= 1) return <span className="text-[9px] font-black uppercase tracking-wide bg-red-500 text-white px-1.5 py-0.5 rounded-full">{t('analytics.dividend_calendar.imminent')}</span>;
        if (days <= 7) return <span className="text-[9px] font-black uppercase tracking-wide bg-orange-400 text-white px-1.5 py-0.5 rounded-full">{t('analytics.dividend_calendar.this_week')}</span>;
        return <span className="text-[9px] font-black uppercase tracking-wide bg-green-500 text-white px-1.5 py-0.5 rounded-full">{t('analytics.dividend_calendar.upcoming')}</span>;
    };

    if (loading) return (
        <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xs h-[400px] flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
    );

    const fmt = (v) => v == null ? '—' : formatNumber(v, 2, 2);
    const thisYearNumber = new Date().getFullYear();

    return (
        <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xs relative">
            {/* Cabecera con el estilo del resto de widgets (Noticias, Puntuación):
                antes era una tarjeta aparte — esquinas de 2.5rem, degradado, sombra
                grande y título text-xl — y la fila de abajo no parecía del mismo panel. */}
            <div className="shrink-0 flex items-center px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                        <CalendarDays className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">{t('analytics.dividend_calendar.title')}</h3>
                        <p className="text-[10px] text-slate-400 mt-px">{t('analytics.dividend_calendar.forecast')}</p>
                    </div>
                </div>
            </div>

            <div className="p-4 md:p-5">

            {/* Annual income forecast */}
            {(annualSummary.prevYear !== null || annualSummary.thisYear !== null || annualSummary.realizedFailed) && (
                <div className="grid grid-cols-3 gap-3 mb-6">
                    {[
                        { label: t('analytics.dividend_calendar.year_real', { year: thisYearNumber - 1 }), value: annualSummary.prevYear, note: annualSummary.realizedFailed ? t('analytics.dividend_calendar.realized_unavailable') : t('analytics.dividend_calendar.collected') },
                        { label: t('analytics.dividend_calendar.year_est', { year: thisYearNumber }), value: annualSummary.thisYear, note: annualSummary.realizedFailed ? t('analytics.dividend_calendar.realized_unavailable') : t('analytics.dividend_calendar.collected_and_projected') },
                        { label: t('analytics.dividend_calendar.year_est', { year: thisYearNumber + 1 }), value: annualSummary.nextYear, note: t('analytics.dividend_calendar.run_rate') },
                    ].map(({ label, value, note }) => (
                        <div key={label} className="bg-emerald-50/80 dark:bg-emerald-900/20 border border-emerald-100/80 dark:border-emerald-800/40 rounded-2xl p-4 text-center shadow-inner">
                            <p className="text-[10px] font-black text-emerald-600/80 dark:text-emerald-500 uppercase tracking-widest mb-1">{label}</p>
                            <p className="text-base md:text-lg font-black text-emerald-700 dark:text-emerald-400 tabular-nums">
                                {privacyMode ? '••••' : value == null ? '—' : `${getCurrencySymbol(currency)}${fmt(value)}`}
                            </p>
                            <p className="text-[9px] font-bold text-emerald-600/60 dark:text-emerald-500/60 mt-1 uppercase tracking-wider">{note}</p>
                        </div>
                    ))}
                </div>
            )}


            {events.length === 0 ? (
                <div className="py-12 text-center bg-slate-50/50 dark:bg-slate-800/30 rounded-2xl border border-slate-100 dark:border-slate-800">
                    <p className="text-sm font-bold text-slate-500">{t('analytics.dividend_calendar.no_dividends')}</p>
                    <p className="text-xs text-slate-400 mt-1.5">{t('analytics.dividend_calendar.us_note')}</p>
                </div>
            ) : (
                <div className="space-y-3 max-h-[380px] overflow-y-auto pr-2 custom-scrollbar">
                    {events.map((ev, i) => {
                        const days = getDaysUntil(ev.exDate);
                        const estimatedTotal = ev.amount && ev.quantity > 0 ? ev.amount * ev.quantity * getRate(ev.currency) : null;
                        const evCurSym = getCurrencySymbol(ev.currency);
                        const displayCurrencySym = getCurrencySymbol(currency);
                        
                        return (
                            <div key={`${ev.ticker}-${i}`}
                                className={`p-4 rounded-2xl border transition-colors shadow-xs hover:shadow-md ${getCardStyle(days)}`}>

                                {/* Row 1: ticker · name · badge */}
                                <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-xs font-black bg-white/50 dark:bg-slate-800/50 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-md border border-emerald-100/50 dark:border-emerald-800/50 shadow-xs shrink-0">{ev.ticker}</span>
                                        <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 truncate">{ev.name}</span>
                                        {ev.isPredicted && (
                                            <span className="text-[9px] font-bold text-slate-400 border border-slate-300 dark:border-slate-600 px-1.5 py-0.5 rounded shrink-0 uppercase tracking-wider">{t('analytics.dividend_calendar.estimated')}</span>
                                        )}
                                    </div>
                                    <UrgencyBadge days={days} />
                                </div>

                                {/* Row 2: ex-date + countdown + payment date */}
                                <div className="flex items-center justify-between mt-3 bg-white/40 dark:bg-slate-900/40 rounded-xl p-2.5">
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <div className="flex items-center gap-1.5">
                                            <Clock className="w-3.5 h-3.5 text-slate-400" />
                                            <span className="text-[9px] text-slate-500 font-black uppercase tracking-wider">{t('analytics.dividend_calendar.ex_div')}</span>
                                            <span className="text-xs font-black text-slate-700 dark:text-slate-200">{formatDate(ev.exDate)}</span>
                                        </div>
                                        <span className="text-[10px] font-bold text-slate-500 bg-slate-200/50 dark:bg-slate-700/50 px-2 py-0.5 rounded-full">{formatCountdown(days)}</span>
                                    </div>
                                    {ev.paymentDate && (
                                        <div className="text-right shrink-0">
                                            <span className="text-[9px] text-slate-500 font-black uppercase tracking-wider">{t('analytics.dividend_calendar.payment')} </span>
                                            <span className="text-xs font-bold text-slate-600 dark:text-slate-300">{formatDate(ev.paymentDate)}</span>
                                        </div>
                                    )}
                                </div>

                                {/* Row 3: dividend amount + estimated total */}
                                {ev.amount !== null && (
                                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-200/60 dark:border-slate-700/40">
                                        <div className="flex items-center gap-1.5 text-[11px] text-slate-500 font-medium">
<span className="font-black text-emerald-600 dark:text-emerald-400">{privacyMode ? '••••' : `${evCurSym}${formatNumber(ev.amount, 2, 4)}`}</span>
                                              <span>{t('analytics.dividend_calendar.per_share')}</span>
                                              {ev.annualDividend && (
                                                  <span className="text-slate-400">({privacyMode ? '••••' : `${evCurSym}${formatNumber(ev.annualDividend, 2, 2)}`}{t('analytics.dividend_calendar.per_year')})</span>
                                            )}
                                        </div>
                                        {estimatedTotal !== null && (
                                            <div className="flex items-center gap-1.5 text-[11px] font-black text-emerald-600 dark:text-emerald-400 bg-emerald-100/50 dark:bg-emerald-900/30 px-2.5 py-1 rounded-lg">
                                                <TrendingUp className="w-3.5 h-3.5" />
                                                {t('analytics.dividend_calendar.est_total', { amount: privacyMode ? '••••' : `${displayCurrencySym}${formatNumber(estimatedTotal, 2, 2)}` })}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            </div>
        </div>
    );
};

export default DividendCalendar;
