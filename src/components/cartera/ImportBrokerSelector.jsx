import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Search, Sparkles } from 'lucide-react';

/**
 * Searchable broker picker — phase 2 of the CSV/XLSX import flow (after the
 * method chooser, before the file upload). Pure presentation: the selected
 * broker and phase navigation are owned by CarteraPage.
 *
 * Adding a broker = one entry here + its parser in src/lib/parsers/.
 * Tailwind needs literal class strings, hence the per-broker style fields.
 *
 * Props:
 *   importBroker    – currently selected broker id (highlights its card)
 *   onSelectBroker  – (id) => void; parent stores it and advances to the upload phase
 *   onSelectFreeform– optional; shown as the escape hatch when the search has no matches
 */
const BROKERS = [
  {
    id: 'degiro',
    name: 'DEGIRO',
    fileHint: 'Account.csv',
    initials: 'D',
    keywords: 'degiro',
    tile: 'bg-orange-500 text-white',
    selected: 'border-orange-400 bg-orange-50 dark:bg-orange-900/10',
    check: 'text-orange-500',
  },
  {
    id: 'ibkr',
    name: 'Interactive Brokers',
    fileHint: 'Activity.csv',
    initials: 'IB',
    keywords: 'interactive brokers ibkr ib',
    tile: 'bg-blue-600 text-white',
    selected: 'border-blue-500 bg-blue-50 dark:bg-blue-900/10',
    check: 'text-blue-500',
  },
  {
    id: 'myinvestor',
    name: 'MyInvestor',
    // La cartera gestionada sólo ofrece este export, y es el que la gente baja.
    // El mismo parser acepta además el CSV de Operaciones y el texto copiado de
    // la pantalla (Composición / Órdenes / Movimientos).
    fileHint: 'Movimientos.xlsx',
    initials: 'MI',
    keywords: 'myinvestor my investor cartera indexada gestionada fondos',
    tile: 'bg-fuchsia-600 text-white',
    selected: 'border-fuchsia-400 bg-fuchsia-50 dark:bg-fuchsia-900/10',
    check: 'text-fuchsia-500',
  },
  {
    id: 'trading212',
    name: 'Trading 212',
    // Menú → Historial → Exportar. Hasta un año por fichero.
    fileHint: 'History.csv',
    initials: 'T',
    keywords: 'trading 212 trading212 t212',
    tile: 'bg-sky-600 text-white',
    selected: 'border-sky-400 bg-sky-50 dark:bg-sky-900/10',
    check: 'text-sky-500',
  },
  // Binance sigue fuera del selector a propósito (2026-07), pero su parser vive:
  // detectBrokerCsv enruta sus exports si se pegan o se sueltan en el import por
  // IA. Volver a ofrecerlo = restaurar su entrada aquí.
];

const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const ImportBrokerSelector = ({ importBroker, onSelectBroker, onSelectFreeform }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const q = normalize(query.trim());
  const filtered = q
    ? BROKERS.filter((b) => normalize(`${b.name} ${b.keywords}`).includes(q))
    : BROKERS;

  return (
    <div>
      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2.5">
        {t('cartera.your_broker')}
      </p>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('cartera.broker_search_placeholder')}
          className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-hidden focus:ring-2 focus:ring-blue-500 transition-all"
        />
      </div>

      {filtered.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {filtered.map((b) => (
            <button
              key={b.id}
              onClick={() => onSelectBroker(b.id)}
              className={`relative p-3.5 rounded-xl border-2 text-left transition-all ${
                importBroker === b.id
                  ? b.selected
                  : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
              }`}
            >
              {importBroker === b.id && (
                <span className="absolute top-2 right-2">
                  <CheckCircle2 className={`w-3.5 h-3.5 ${b.check}`} />
                </span>
              )}
              <div className="flex items-center gap-2.5">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${b.tile}`}>
                  <span className="font-black text-[11px]">{b.initials}</span>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">{b.name}</p>
                  <p className="text-[10px] text-slate-400 truncate">{b.fileHint}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-700 p-5 text-center">
          <p className="text-[12px] text-slate-500 dark:text-slate-400">
            {t('cartera.broker_search_empty', { q: query.trim() })}
          </p>
          {onSelectFreeform && (
            <button
              onClick={onSelectFreeform}
              className="mt-3 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-[12px] font-semibold transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {t('freeform_import.card_title')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ImportBrokerSelector;
