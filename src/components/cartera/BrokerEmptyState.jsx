import React from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, PenLine, Sparkles, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Los que tienen importador propio (lib/parsers). El resto pasa por la lectura
// con IA del CSV: lo que se promete aquí tiene que existir.
const SUPPORTED_BROKERS = ['DEGIRO', 'Interactive Brokers', 'MyInvestor', 'Trading 212', 'Binance'];

/**
 * Lo que ve en Brokers un broker sin nada dentro (la cuenta recién creada, o un
 * broker nuevo). Sustituye a las tres tarjetas a cero y a la tabla vacía.
 *
 * Antes había una guía de texto ("haz clic en el botón + de la parte
 * superior…, pulsa Importar CSV…") que describía botones en vez de darlos, y
 * debajo tres tarjetas con "0,00 US$". Ahora la acción principal es UN botón.
 */
export default function BrokerEmptyState({ onImport, onAddPosition }) {
  const { t } = useTranslation();

  return (
    <section
      className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl shadow-xs p-6 md:p-10"
      aria-labelledby="broker-empty-title"
    >
      <div className="max-w-2xl mx-auto text-center">
        <div className="w-12 h-12 mx-auto rounded-xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center mb-4">
          <Upload className="w-6 h-6 text-blue-600 dark:text-blue-400" />
        </div>
        <h2 id="broker-empty-title" className="text-xl md:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
          {t('broker_empty.title')}
        </h2>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {t('broker_empty.desc')}
        </p>

        <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Button size="lg" onClick={onImport} className="w-full sm:w-auto">
            <Upload className="w-4 h-4 mr-2" />
            {t('broker_empty.cta_import')}
          </Button>
          <Button size="lg" variant="outline" onClick={onAddPosition} className="w-full sm:w-auto">
            <PenLine className="w-4 h-4 mr-2" />
            {t('broker_empty.cta_manual')}
          </Button>
        </div>

        <div className="mt-8">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">
            {t('broker_empty.supported_title')}
          </p>
          <ul className="flex flex-wrap justify-center gap-2">
            {SUPPORTED_BROKERS.map((name) => (
              <li key={name} className="px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-xs font-semibold text-slate-700 dark:text-slate-200">
                {name}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-violet-500 shrink-0" />
            {t('broker_empty.other_broker')}
          </p>
        </div>

        <p className="mt-6 text-[11px] text-slate-400 dark:text-slate-500 inline-flex items-center gap-1.5">
          <Lock className="w-3 h-3 shrink-0" />
          {t('broker_empty.privacy')}
        </p>
      </div>
    </section>
  );
}
