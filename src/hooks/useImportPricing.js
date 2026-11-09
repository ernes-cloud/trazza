/**
 * Precios de las filas importadas y re-resolución del símbolo de los fondos de
 * un broker. Sacado de pages/CarteraPage.jsx (2026-10-04) sin cambios de
 * lógica; el estado (precios importados, mapa de tickers) sigue viviendo en la
 * página y se inyecta, igual que en useImportFlow.
 *
 * - fetchPricesForImported(rows): cotiza lo importado (mapas estático → sesión →
 *   compartido → búsqueda en Yahoo), cura nombres placeholder y aporta las
 *   resoluciones ISIN→ticker a la tabla compartida. SECUENCIAL a propósito.
 * - handleReresolveFunds(): vuelve a resolver los fondos con el ticker fosilizado
 *   en imported_data.ticker_map; SOLO mejora (nunca degrada un símbolo que da
 *   precio) y rechaza un cambio que movería el valor de la posición > 2 %.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { yahooFinanceService } from '@/services/yahooFinance';
import { marketDataService } from '@/services/marketDataService';
import { resolveFundSymbol, looksLikeUnresolvedFundName } from '@/services/import/fundNavEnricher';
import { loadSharedTickerMappings, saveTickerMappings } from '@/services/tickerMappingService';
import { resolveTicker, TICKER_MAP } from '@/lib/tickerMap';
import { isHeldInvestedPosition } from '@/lib/positionKind';

export function useImportPricing({
  user, positions, selectedBrokerId, refreshPrices,
  importPrices, setImportPrices, dynamicTickerMap, setDynamicTickerMap, dynamicTickerMapRef,
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [reresolvingFunds, setReresolvingFunds] = useState(false);

  const fetchPricesForImported = async (data) => {
    const assetStats = {};
    data.forEach(t => {
      // noQuote rows (MyInvestor movimientos funds: monetary qty, no ISIN) must
      // never reach the name-based Yahoo search — a wrong match would price
      // EUR-denominated quantities with a real NAV and corrupt the value.
      if (t.noQuote) return;
      const tickerIdentifier = t.id_activo || t.producto || t.isin;
      if (tickerIdentifier) {
        const ticker = t.displayTicker || resolveTicker(tickerIdentifier);
        const cur = (t.moneda || 'EUR').toUpperCase();
        assetStats[tickerIdentifier] = {
          ticker: ticker,
          name: t.nombre || t.name || t.producto,
          // Store DB ticker so we can heal company_name when it was set to the ISIN placeholder
          dbTicker: t.isin ? `${t.isin} (${cur})` : null,
          isin: t.isin || null,
        };
      }
    });

    const prices = { ...importPrices };
    const resolvedTickers = { ...dynamicTickerMap };

    // Shared crowd-sourced ISIN→ticker mappings: resolves ISINs other users
    // already resolved, skipping the Yahoo search (and its mis-resolutions).
    const sharedMappings = await loadSharedTickerMappings();
    const newlyResolved = {}; // ISIN → ticker discovered via search in THIS run

    for (const identifier of Object.keys(assetStats)) {
      let tickerToTry = resolveTicker(assetStats[identifier].ticker);
      const nameToTry = assetStats[identifier].name;

      // Precedence: static map (inside resolveTicker) → session map → shared table
      const identifierIsin = assetStats[identifier].isin;
      if (tickerToTry === identifier || !tickerToTry) {
        const shared = sharedMappings[identifier] || (identifierIsin && sharedMappings[identifierIsin]);
        if (shared) {
          tickerToTry = shared;
          resolvedTickers[identifier] = shared;
        }
      }
      
      // Skip cash, liquidity, transfers and other internal identifiers
      const skipTerms = ['LIQUIDEZ', 'CASH', 'TRANSFER', 'INTEREST', 'DIVIDEND', 'FEE', 'TOTAL', 'SUMMARY', 'DEPOSITO', 'RETIRADA', 'EURO', 'DIVISA', 'DEPOSIT'];
      if (!tickerToTry || skipTerms.some(term => tickerToTry.toUpperCase().includes(term))) {
        continue;
      }

      try {
        let quote = null;
        try {
          // A ticker with whitespace is an unresolved fund NAME: skip straight
          // to the search (quoting it fails on every provider and burns the
          // EODHD fallback quota).
          if (/\s/.test(tickerToTry)) throw new Error('unquotable name');
          quote = await marketDataService.getQuote(tickerToTry);
        } catch (e) {
          let searchResults = await yahooFinanceService.searchTickers(tickerToTry);
          if ((!searchResults || searchResults.length === 0) && nameToTry) {
            searchResults = await yahooFinanceService.searchTickers(nameToTry);
          }
          if (searchResults && searchResults.length > 0) {
            const bestMatch = searchResults.find(r =>
              (r.type?.toUpperCase() === 'EQUITY' || r.type?.toUpperCase() === 'COMMONSTOCK') &&
              !r.symbol.includes('=')
            ) || searchResults[0];
            // Never let a search result override a statically-mapped ISIN — the static
            // TICKER_MAP is authoritative and a search fallback can return wrong tickers.
            const staticMapped = TICKER_MAP[identifier.toUpperCase()];
            if (!staticMapped) {
              tickerToTry = bestMatch.symbol;
              resolvedTickers[identifier] = tickerToTry;
            } else {
              tickerToTry = staticMapped;
            }
            quote = await marketDataService.getQuote(tickerToTry);
          }
        }
        if (quote) {
          prices[tickerToTry] = quote.current;
          prices[identifier] = quote.current;
          resolvedTickers[identifier] = tickerToTry;

          // Heal company_name when it was set to the ISIN as a placeholder (MyInvestor imports
          // have no name column — the asset is created with isin as company_name on first import).
          const meta = assetStats[identifier];
          if (quote.companyName && meta?.dbTicker && meta?.isin && meta.isin === identifier) {
            // Resolve the asset id, then heal via RPC (direct asset UPDATEs are RLS-blocked).
            // The RPC only applies company_name when the stored name is still a placeholder.
            supabase.from('assets')
              .select('id')
              .eq('ticker', meta.dbTicker)
              .eq('company_name', meta.isin)
              .limit(1)
              .then(({ data: placeholderRows }) => {
                const placeholderId = placeholderRows?.[0]?.id;
                if (!placeholderId) return;
                return supabase.rpc('update_asset_metadata', {
                  p_asset_id: placeholderId,
                  p_company_name: quote.companyName,
                });
              });
          }
        }
      } catch (e) { console.warn(`Price fetch failed for ${tickerToTry}`); }
    }

    // Add ISIN-keyed entries so the performance chart can look up DB transactions by ISIN
    // (DB transactions store assets.ticker as "ISIN (CUR)" but the chart looks up dynamicTickerMap[isin])
    data.forEach(t => {
      const identifier = t.id_activo || t.producto || t.isin;
      if (t.isin && identifier && t.isin !== identifier) {
        const resolved = resolvedTickers[identifier];
        if (resolved && !resolvedTickers[t.isin]) resolvedTickers[t.isin] = resolved;
      }
    });

    // Contribute this session's ISIN resolutions to the shared crowd-sourced
    // table (fire-and-forget) so no other user re-searches the same ISINs.
    Object.entries(resolvedTickers).forEach(([key, tk]) => {
      if (/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(key) && tk && !sharedMappings[key]) {
        newlyResolved[key] = tk;
      }
    });
    saveTickerMappings(newlyResolved);

    setImportPrices(prices);
    setDynamicTickerMap(resolvedTickers);
  };

  /**
   * Vuelve a resolver el símbolo de cotización de los fondos del broker.
   *
   * Un ticker mal resuelto se FOSILIZA: queda escrito en `imported_data.ticker_map`
   * y el refresco de precios lo usa para siempre, por mucho que se pulse
   * Actualizar. Hasta ahora la única salida era reimportar el extracto con
   * "reemplazar" — borrar y recrear transacciones sólo para corregir un símbolo.
   *
   * Regla de oro: esto SÓLO mejora. Si un fondo no se resuelve, se deja
   * exactamente como estaba; degradar a "no sé" un símbolo que hoy da precio
   * sería peor que el problema que viene a arreglar.
   */
  const handleReresolveFunds = async () => {
    if (reresolvingFunds) return;

    // Los símbolos reales no llevan espacios: las filas monetarias guardan el
    // NOMBRE del fondo como ticker, y ésos son los que dependen del mapa.
    const nombres = [...new Set(
      (positions || [])
        // isHeldInvestedPosition = no es liquidez y sigue abierta: una posición
        // cerrada no necesita precio, y la liquidez no cotiza.
        .filter((p) => isHeldInvestedPosition(p) && looksLikeUnresolvedFundName(p.assets?.ticker))
        .map((p) => (p.assets.ticker || '').replace(/\s*\([A-Z]{3}\)$/i, '').trim())
        .filter(Boolean)
    )];

    if (nombres.length === 0) {
      toast({ title: t('cartera.reresolve_none') });
      return;
    }

    setReresolvingFunds(true);
    toast({ title: t('cartera.reresolve_running') });
    try {
      const mapa = { ...(dynamicTickerMapRef.current || {}) };
      const corregidos = [];
      const sinResolver = [];
      // Cambios que NO se aplican porque moverían el valor de la posición: ahí
      // el arreglo es reimportar (recalcula unidades y símbolo a la vez).
      const arriesgados = [];

      // Secuencial y pausado: Yahoo estrangula las ráfagas (misma razón que
      // fundNavEnricher y fundSectors).
      for (const nombre of nombres) {
        const encontrado = await resolveFundSymbol(nombre, {
          searchTickers: (q) => yahooFinanceService.searchTickers(q),
          getQuote: (s) => yahooFinanceService.getQuote(s),
          currency: 'EUR',
          pauseMs: 250,
        });
        if (!encontrado?.symbol) { sinResolver.push(nombre); continue; }
        if (mapa[nombre] === encontrado.symbol) continue; // ya estaba bien

        // GUARDA: cambiar de símbolo sólo es inocuo si el valor de la posición
        // no se mueve. Dos clases del mismo fondo siguen el mismo índice pero
        // tienen NAV distinto, y cuando las unidades se DERIVARON del NAV de la
        // clase vieja, unidades y precio son coherentes entre sí: cambiar sólo
        // el símbolo rompe esa coherencia (medido: una posición de 119 € se
        // quedaría en 83 €). Un salto grande significa "hay que reimportar para
        // recalcular las unidades", no "aplícalo igualmente".
        const fila = (positions || []).find((p) => (p.assets?.ticker || '').replace(/\s*\([A-Z]{3}\)$/i, '').trim() === nombre);
        const unidades = Number(fila?.quantity) || 0;
        const precioViejo = Number(fila?.assets?.current_price) || 0;
        let precioNuevo = 0;
        try { precioNuevo = Number((await yahooFinanceService.getQuote(encontrado.symbol))?.price) || 0; } catch (_) { /* sin precio */ }

        if (unidades > 0 && precioViejo > 0 && precioNuevo > 0) {
          const salto = Math.abs(precioNuevo / precioViejo - 1);
          if (salto > 0.02) {
            arriesgados.push({ nombre, antes: unidades * precioViejo, despues: unidades * precioNuevo });
            continue;
          }
        }

        mapa[nombre] = encontrado.symbol;
        corregidos.push(nombre);
      }

      if (corregidos.length > 0) {
        setDynamicTickerMap(mapa);
        dynamicTickerMapRef.current = mapa;
        // Persistir en el mapa del broker. `update` y no `upsert`: un upsert
        // tendría que mandar transactions/prices y machacaría lo guardado.
        if (user?.id && selectedBrokerId && selectedBrokerId !== 'general') {
          const { error } = await supabase.from('imported_data')
            .update({ ticker_map: mapa, updated_at: new Date().toISOString() })
            .eq('user_id', user.id)
            .eq('broker_id', selectedBrokerId);
          if (error) console.error('[reresolve] no se pudo guardar el mapa:', error.message);
        }
        await refreshPrices();
      }

      const names = (arr) => arr.slice(0, 3).join(', ') + (arr.length > 3 ? '…' : '');
      if (corregidos.length === 1) {
        toast({ title: t('cartera.reresolve_done_one', { names: names(corregidos) }) });
      } else if (corregidos.length > 1) {
        toast({ title: t('cartera.reresolve_done', { count: corregidos.length, names: names(corregidos) }) });
      } else {
        toast({ title: t('cartera.reresolve_nochange', { count: nombres.length }) });
      }
      if (sinResolver.length > 0) {
        toast({
          title: t('cartera.reresolve_unresolved', { count: sinResolver.length, names: names(sinResolver) }),
          variant: 'destructive',
        });
      }
      if (arriesgados.length > 0) {
        const fmt = (n) => `${n.toFixed(2)} €`;
        toast({
          title: t('cartera.reresolve_needs_reimport', { count: arriesgados.length }),
          description: arriesgados
            .slice(0, 3)
            .map((a) => `${a.nombre}: ${fmt(a.antes)} → ${fmt(a.despues)}`)
            .join(' · '),
          variant: 'destructive',
        });
      }
    } catch (err) {
      console.error('[reresolve] fallo:', err);
      toast({ title: t('cartera.reresolve_failed'), description: err?.message, variant: 'destructive' });
    } finally {
      setReresolvingFunds(false);
    }
  };

  return { fetchPricesForImported, handleReresolveFunds, reresolvingFunds };
}
