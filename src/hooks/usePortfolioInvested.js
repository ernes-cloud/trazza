/**
 * "Invertido en cartera" para la pantalla de Gastos: el VALOR DE MERCADO de la
 * cartera — la misma cifra que brokers enseña como "Valor en Mercado" y el
 * Dashboard como "Invertido". Antes era el coste base híbrido (investedHybrid),
 * otra magnitud, y el patrimonio de Gastos nunca cuadraba con las otras dos.
 *
 * Tres fuentes, de más fresca a menos:
 *   1. el snapshot en memoria del Dashboard (precios vivos, cero red) — solo si
 *      cubre TODOS los brokers: el de un broker suelto no es el patrimonio
 *   2. la caché de cabecera que publica brokers (scope "general:display", las
 *      cifras exactas que pintó), convertida con FX si se escribió en otra divisa
 *   3. valorar las posiciones con los precios de BD que escriben las dos pantallas
 *
 * La fuente 3 descarga la cartera para dos líneas de texto, así que solo corre
 * con `enabled` (la página pasa initReady && widget del hero visible) y cuando
 * las dos rápidas no están disponibles.
 *
 * Sacado de pages/ExpensesPage.jsx (2026-10-04) sin cambios de lógica.
 *
 * @returns {number|null} valor invertido en `currency`, o null si no se pudo
 */
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/customSupabaseClient';
import { currencyService } from '@/services/currencyService';
import { computeInvestedMarketValue } from '@/services/portfolioStats';

export function usePortfolioInvested({ userId, currency, enabled, portfolioSnapshot }) {
  const [portfolioInvested, setPortfolioInvested] = useState(null);

  useEffect(() => {
    if (!userId || !enabled) return;
    let cancelled = false;
    (async () => {
      const snap = portfolioSnapshot;
      if (snap?.scope === 'general' && Number.isFinite(snap.totalWealth) && Number.isFinite(snap.cashPosition)) {
        // Exactamente el "Invertido" del Dashboard: patrimonio menos su liquidez.
        const liveInvested = snap.totalWealth - snap.cashPosition;
        if (snap.currency === currency) {
          setPortfolioInvested(liveInvested);
          return;
        }
        const rate = await currencyService.getExchangeRate(snap.currency, currency);
        if (!cancelled && Number.isFinite(rate) && rate > 0) {
          setPortfolioInvested(liveInvested * rate);
          return;
        }
      }

      try {
        const { data: cacheRow, error: cacheError } = await supabase
          .from('portfolio_metrics_cache')
          .select('currency, metrics')
          .eq('user_id', userId)
          .eq('scope', 'general:display')
          .maybeSingle();
        if (cacheError) throw cacheError;
        const cached = cacheRow?.metrics?.investedValue;
        if (Number.isFinite(cached) && cacheRow?.currency) {
          if (cacheRow.currency === currency) {
            if (!cancelled) setPortfolioInvested(cached);
            return;
          }
          // Convertir la cifra cacheada sale mejor que volver a descargar todas
          // las posiciones solo porque la divisa de pantalla no es la cacheada.
          const rate = await currencyService.getExchangeRate(cacheRow.currency, currency);
          if (Number.isFinite(rate) && rate > 0) {
            if (!cancelled) setPortfolioInvested(cached * rate);
            return;
          }
        }
      } catch (e) {
        console.warn('[ExpensesPage] metrics cache unavailable, recomputing:', e?.message);
      }

      try {
        // Las posiciones se poseen vía broker (no tienen user_id): primero los
        // brokers del usuario y luego sus posiciones, igual que Dashboard/brokers.
        const { data: userBrokers, error: brokersError } = await supabase.from('brokers').select('id').eq('user_id', userId);
        if (brokersError) throw brokersError;
        const brokerIds = (userBrokers || []).map((b) => b.id);
        if (brokerIds.length === 0) { if (!cancelled) setPortfolioInvested(null); return; }
        const { data: allPos, error: posError } = await supabase
          .from('positions')
          .select('id, quantity, entry_price, assets(currency, ticker, isin, asset_class, current_price)')
          .in('broker_id', brokerIds);
        if (posError) throw posError;
        if (!allPos?.length) { if (!cancelled) setPortfolioInvested(null); return; }
        const currencies = [...new Set(allPos.map((p) => p.assets?.currency).filter((c) => c && c !== currency))];
        const pairs = await Promise.all(currencies.map(async (c) => [c, await currencyService.getExchangeRate(c, currency)]));
        const rates = Object.fromEntries(pairs);
        // Las filas cerradas (qty 0) siguen en la tabla tras ventas y cierres de CSV.
        const held = allPos.filter((p) => parseFloat(p.quantity) > 0.0001);
        const invested = computeInvestedMarketValue(held, rates).toNumber();
        if (!cancelled) setPortfolioInvested(Number.isFinite(invested) ? invested : null);
      } catch (e) {
        // Cifra secundaria: un fallo la oculta en vez de bloquear la página,
        // pero nunca se traga en silencio.
        console.warn('[ExpensesPage] could not compute portfolio invested:', e?.message);
        if (!cancelled) setPortfolioInvested(null);
      }
    })();
    return () => { cancelled = true; };
  }, [userId, currency, enabled, portfolioSnapshot]);

  return portfolioInvested;
}
