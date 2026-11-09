import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Upload, TrendingUp, PieChart, CalendarDays, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';

const PREVIEW = [
  { icon: TrendingUp, key: 'preview_return' },
  { icon: PieChart, key: 'preview_allocation' },
  { icon: CalendarDays, key: 'preview_dividends' },
  { icon: Gauge, key: 'preview_score' },
];

/**
 * Lo que ve en el Dashboard una cuenta que aún no tiene posiciones.
 *
 * Antes eran 8 tarjetas vacías ("Sin posiciones para mostrar", 0 €, un gráfico
 * sin datos…) y ninguna decía qué hacer. Ahora una sola tarjeta explica qué se
 * verá aquí y abre el importador de Brokers (`/app/brokers?start=import`); allí
 * un broker vacío enseña `BrokerEmptyState`. Los widgets que dependen de posiciones se ocultan
 * (`layoutForEmptyPortfolio`) sin tocar el layout guardado.
 */
export default function EmptyPortfolioHero() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <section
      className="order-first lg:col-span-3 bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-2xl shadow-xs p-6 md:p-8"
      aria-labelledby="empty-portfolio-title"
    >
      <div className="flex flex-col md:flex-row md:items-center gap-6 md:gap-10">
        <div className="flex-1 min-w-0">
          <div className="w-11 h-11 rounded-xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center mb-4">
            <Upload className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <h2 id="empty-portfolio-title" className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            {t('dashboard_empty.title')}
          </h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400 max-w-xl">
            {t('dashboard_empty.desc')}
          </p>
          <Button className="mt-5" onClick={() => navigate('/app/brokers?start=import')}>
            <Upload className="w-4 h-4 mr-2" />
            {t('dashboard_empty.cta')}
          </Button>
        </div>

        <div className="md:w-72 shrink-0 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-3">
            {t('dashboard_empty.preview_title')}
          </p>
          <ul className="space-y-2.5">
            {PREVIEW.map(({ icon: Icon, key }) => (
              <li key={key} className="flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300">
                <Icon className="w-4 h-4 text-slate-400 shrink-0" />
                {t(`dashboard_empty.${key}`)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
