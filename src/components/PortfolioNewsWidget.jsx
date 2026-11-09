import React, { useEffect, useState, useRef } from 'react';
import { yahooFinanceService } from '@/services/yahooFinance';
import { Newspaper, ExternalLink, Loader2, RefreshCw, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { resolveQuoteSymbol, isQuotableSymbol } from '@/services/quoteSymbol';
import { interleaveByTicker } from '@/lib/newsMix';
import { isCashPosition } from '@/lib/positionKind';
import { runPooledSettled } from '@/lib/asyncPool';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const LS_KEY = 'wf_portfolio_news_cache';

// La caché va atada a los activos que se piden: sin eso, otra cuenta en el
// mismo navegador (o otro broker en el filtro) veía 15 min las noticias de la
// cartera anterior — y con ellas qué tenía.
const loadCache = (key) => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const { ts, items, key: cachedKey } = JSON.parse(raw);
    if (cachedKey === key && Date.now() - ts < CACHE_TTL_MS) return items;
  } catch { /* localStorage corrupto o bloqueado: se pide de nuevo */ }
  return null;
};

const saveCache = (key, items) => {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), key, items })); } catch { /* cuota o bloqueado */ }
};

const timeAgo = (ts, t) => {
  if (!ts) return '';
  const diff = Math.floor((Date.now() / 1000 - ts) / 60);
  if (diff < 60) return t('portfolio_news.time_minutes', { n: diff });
  if (diff < 1440) return t('portfolio_news.time_hours', { n: Math.floor(diff / 60) });
  return t('portfolio_news.time_days', { n: Math.floor(diff / 1440) });
};

const PortfolioNewsWidget = ({ positions = [] }) => {
  const { t } = useTranslation();
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(false);
  // 8 y no 6: con la lista rellenando la fila (~560px) seis noticias dejaban
  // 36px sin pintar al final. Ocho desbordan siempre, y el scroll interno se
  // encarga — el lote no afecta al alto de la fila (el scroller va absoluto).
  const [visibleCount, setVisibleCount] = useState(8);
  // Última cartera para la que se pidieron noticias: al cambiar el filtro de
  // broker cambian los activos y hay que volver a pedirlas (antes era un
  // booleano y el widget se quedaba con las de la primera carga).
  const fetchedRef = useRef(null);
  const positionsKey = positions
    .filter(p => !isCashPosition(p))
    .map(p => p.assets?.ticker)
    .filter(Boolean)
    .sort()
    .join(',');

  const fetchNews = async (force = false) => {
    const tickers = [...new Set(
      positions
        .filter(p => !isCashPosition(p))
        // Mismo símbolo con el que se cotiza (un fondo se guarda por su NOMBRE;
        // resolveTicker lo dejaba tal cual y se pedían noticias de "VANGUARD 20").
        .map(p => resolveQuoteSymbol(p.assets?.ticker))
        .filter(isQuotableSymbol)
    )].slice(0, 12); // limit concurrent requests

    if (tickers.length === 0) return;
    const cacheKey = [...tickers].sort().join(',');
    if (!force) {
      const cached = loadCache(cacheKey);
      if (cached) { setNews(cached); return; }
    }

    setLoading(true);
    try {
      // Pool, no ráfaga: Yahoo estrangula las ráfagas (ver lib/asyncPool).
      const results = await runPooledSettled(tickers.map(t => () => yahooFinanceService.getNews(t)));
      const seen = new Set();
      const unique = results
        .flatMap((r, i) => {
          if (r.status !== 'fulfilled') return [];
          return (r.value || []).map(n => ({ ...n, ticker: tickers[i] }));
        })
        .filter(n => {
          if (!n.headline || !n.url || seen.has(n.url)) return false;
          seen.add(n.url);
          return true;
        })
        ;
      // Repartidas por activo (ver lib/newsMix), no solo por fecha.
      const merged = interleaveByTicker(unique).slice(0, 40);

      setNews(merged);
      saveCache(cacheKey, merged);
    } catch (e) {
      console.error('PortfolioNewsWidget error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!positionsKey || fetchedRef.current === positionsKey) return;
    fetchedRef.current = positionsKey;
    fetchNews();
  }, [positionsKey]);

  const visible = news.slice(0, visibleCount);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl overflow-hidden shadow-xs flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
            <Newspaper className="w-4 h-4 text-blue-500" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">{t('portfolio_news.title')}</h3>
            <p className="text-[10px] text-slate-400 mt-px">{t('portfolio_news.subtitle')}</p>
          </div>
        </div>
        <button
          onClick={() => fetchNews(true)}
          disabled={loading}
          className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          title={t('portfolio_news.refresh')}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Content — la lista RELLENA el alto que le deje la fila (flex-1) en vez de
          capar a una altura fija: la card estira con h-full y la fila la marca el
          widget más alto que la comparta (Previsión/Calendario), así que el tope
          fijo dejaba un hueco blanco de ~180px al final de la card.
          El scroller va ABSOLUTO dentro de un contenedor relative: fuera de flujo,
          su contenido no infla la fila — 6 noticias con miniatura miden ~530px y
          estirarían a los vecinos, que es justo lo que el tope evitaba.
          min-h-[380px] conserva EXACTAMENTE la contribución de antes; sin él la
          lista colapsaría a 0 en móvil, donde la fila mide su contenido.
          overflow-x-hidden EXPLÍCITO: con overflow-y:auto el eje X computa a auto
          y pinta una barra horizontal. */}
      <div className="relative flex-1 min-h-[380px]">
        <div className="absolute inset-0 divide-y divide-slate-50 dark:divide-slate-800/60 overflow-y-auto overflow-x-hidden custom-scrollbar">
        {loading && news.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-12 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs font-medium">{t('portfolio_news.loading')}</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-400">
            {t('portfolio_news.empty')}
          </div>
        ) : (
          visible.map((item, i) => (
            <a
              key={item.url || i}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 px-5 py-3.5 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors group"
            >
              {item.image ? (
                <img
                  src={item.image}
                  alt=""
                  loading="lazy"
                  className="w-14 h-14 rounded-lg object-cover shrink-0 bg-slate-100 dark:bg-slate-800"
                  onError={e => { e.target.style.display = 'none'; }}
                />
              ) : (
                <div className="w-14 h-14 rounded-lg bg-slate-100 dark:bg-slate-800 shrink-0 flex items-center justify-center">
                  <Newspaper className="w-5 h-5 text-slate-300 dark:text-slate-600" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 leading-snug line-clamp-2 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                    {item.headline}
                  </p>
                  <ExternalLink className="w-3 h-3 text-slate-300 dark:text-slate-600 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  {item.ticker && (
                    <span className="text-[10px] font-bold px-1.5 py-px bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded">
                      {item.ticker}
                    </span>
                  )}
                  {item.source && (
                    <span className="text-[10px] text-slate-400 font-medium truncate">{item.source}</span>
                  )}
                  {item.datetime && (
                    <span className="text-[10px] text-slate-300 dark:text-slate-600 ml-auto shrink-0">{timeAgo(item.datetime, t)}</span>
                  )}
                </div>
              </div>
            </a>
          ))
        )}
        </div>
      </div>

      {/* Show more */}
      {news.length > visibleCount && (
        <div className="shrink-0 px-5 py-3 border-t border-slate-100 dark:border-slate-800">
          <button
            onClick={() => setVisibleCount(v => v + 6)}
            className="w-full flex items-center justify-center gap-1.5 text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:text-blue-700 py-1 transition-colors"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            {t('portfolio_news.show_more', { n: Math.min(6, news.length - visibleCount) })}
          </button>
        </div>
      )}
    </div>
  );
};

export default PortfolioNewsWidget;
