import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Upload, Lock, AlertTriangle, FileText } from 'lucide-react';
import { parseDegiroTransactions, isCsvTooBig } from '@/services/publicTools/degiroTransactions';
import { computeCapitalGains } from '@/services/publicTools/capitalGains';
import { TOOL_COLORS } from './PublicToolShell';
import CapitalGainsResult from './CapitalGainsResult';

const { TEXT, MUTED, FAINT, RULE, ACCENT, PANEL } = TOOL_COLORS;

/** Fecha de la última revisión del contenido fiscal de esta página (visible). */
export const RENTA_CALC_UPDATED = '2026-10-22';

// CSV de EJEMPLO, INVENTADO (no son operaciones de nadie): mismo formato que el
// Transactions.csv de DEGIRO en español, con una pérdida bloqueada por la regla
// de los dos meses para que se vea el aviso.
const EXAMPLE_CSV = [
  'Fecha,Hora,Producto,ISIN,Bolsa de,Centro de ejecución,Número,Precio,,Valor local,,Valor,,Tipo de cambio,Costes de transacción,,Total,,ID Orden',
  '20-03-2025,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,5,"82,00",EUR,"-410,00",EUR,"-410,00",EUR,,"-1,00",EUR,"-411,00",EUR,ejemplo-4',
  '01-03-2025,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,-10,"80,00",EUR,"800,00",EUR,"800,00",EUR,,"-1,00",EUR,"799,00",EUR,ejemplo-3',
  '15-01-2025,15:40,EJEMPLO CORP,US0000EJEMP1,NDQ,XNAS,-4,"230,00",USD,"920,00",USD,"885,00",EUR,"1,0395","-1,00",EUR,"884,00",EUR,ejemplo-2',
  '03-02-2024,15:40,EJEMPLO CORP,US0000EJEMP1,NDQ,XNAS,4,"200,00",USD,"-800,00",USD,"-740,00",EUR,"1,0811","-1,00",EUR,"-741,00",EUR,ejemplo-1',
  '10-01-2024,10:00,EJEMPLO ETF MUNDIAL,IE00EJEMPLO01,EAM,XAMS,10,"100,00",EUR,"-1000,00",EUR,"-1000,00",EUR,,"-1,00",EUR,"-1001,00",EUR,ejemplo-0',
].join('\n');

const SOURCES = [
  { key: 'src_lirpf', href: 'https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764' },
  { key: 'src_aeat_f2', href: 'https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-ayuda-presentacion/irpf-2025/7-cumplimentacion-irpf/7_6-ganancias-perdidas-patrimoniales/7_6_6-cumplimentacion/7_6_6_2-apartado-f2.html' },
  { key: 'src_aeat_2m', href: 'https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-ayuda-presentacion/irpf-2025/7-cumplimentacion-irpf/7_6-ganancias-perdidas-patrimoniales/7_6_1-conceptos-generales/7_6_1_1-concepto-ganancias-perdidas-patrimoniales/integracion-diferida-perdidas-patrimoniales.html' },
];

/**
 * Renta desde el CSV de transacciones de DEGIRO. El fichero se lee con
 * `File.text()` y se calcula aquí: NO se envía a ningún servidor ni se guarda
 * (ni localStorage). Lector en services/publicTools/degiroTransactions.js y
 * cálculo en capitalGains.js, los dos puros y testeados.
 */
export default function DegiroCsvCalculator() {
  const { t, i18n } = useTranslation();
  const [source, setSource] = useState(null); // { name, text, example }
  const [readError, setReadError] = useState(null); // 'read' | 'too_big'

  const parsed = useMemo(() => (source ? parseDegiroTransactions(source.text) : null), [source]);
  const result = useMemo(() => (parsed?.ok ? computeCapitalGains(parsed.operations) : null), [parsed]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (isCsvTooBig(file.size)) { setReadError('too_big'); setSource(null); return; }
    try {
      setReadError(null);
      setSource({ name: file.name, text: await file.text(), example: false });
    } catch {
      setReadError('read');
      setSource(null);
    }
  };

  const locale = i18n.language?.startsWith('en') ? 'en-US' : 'es-ES';
  const updated = new Date(`${RENTA_CALC_UPDATED}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const skippedReasons = parsed?.skipped?.reduce((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] || 0) + 1 }), {}) || {};
  const label = (key) => {
    const name = parsed?.products?.[key];
    return name && name !== key ? `${name} (${key})` : key;
  };

  return (
    <div className="bg-white">
      <div className="p-5 md:p-8" style={{ borderBottom: `1px solid ${RULE}` }}>
        <p className="flex gap-2 rounded-xl px-4 py-3 text-[13px] mb-6" style={{ backgroundColor: PANEL, color: MUTED }}>
          <Lock className="w-4 h-4 shrink-0 mt-0.5" style={{ color: ACCENT }} />
          <span><strong style={{ color: TEXT }}>{t('renta_calc.privacy_title')}</strong> {t('renta_calc.privacy_body')}</span>
        </p>

        <h2 className="text-[15px] font-bold mb-1" style={{ color: TEXT }}>{t('renta_calc.upload_title')}</h2>
        <p className="text-[13px] mb-4" style={{ color: FAINT }}>
          {t('renta_calc.upload_hint')}{' '}
          <Link to="/guias/degiro" className="underline" style={{ color: ACCENT }}>{t('renta_calc.guide_link')}</Link>
        </p>

        <div className="flex flex-wrap gap-2 items-center">
          <label className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-[14px] font-semibold cursor-pointer" style={{ backgroundColor: ACCENT, color: '#fff' }}>
            <Upload className="w-4 h-4" />{t('renta_calc.upload_btn')}
            <input type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" />
          </label>
          <button type="button" onClick={() => { setReadError(null); setSource({ name: 'ejemplo.csv', text: EXAMPLE_CSV, example: true }); }} className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2.5 text-[13px] font-semibold" style={{ border: `1px solid ${RULE}`, color: ACCENT }}>
            <FileText className="w-4 h-4" />{t('renta_calc.example_btn')}
          </button>
        </div>

        {source && (
          <p className="mt-4 text-[13px]" style={{ color: MUTED }}>
            {source.example ? t('renta_calc.example_loaded') : t('renta_calc.file_loaded', { name: source.name })}
            {parsed?.ok && ` ${t('renta_calc.ops_read', { count: parsed.operations.length })}`}
          </p>
        )}
        {(readError || (parsed && !parsed.ok)) && (
          <p className="mt-3 text-[13px] flex gap-1.5" style={{ color: '#b91c1c' }}>
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            {t(`renta_calc.error_${readError || parsed.error}`)}
          </p>
        )}
        {Object.entries(skippedReasons).map(([reason, count]) => (
          <p key={reason} className="mt-2 text-[12px] flex gap-1.5" style={{ color: '#b45309' }}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{t(`renta_calc.skipped_${reason}`, { count })}
          </p>
        ))}
        {parsed?.ok && parsed.incompleteAssets.length > 0 && (
          <div className="mt-3 rounded-xl px-4 py-3 text-[13px]" style={{ border: '1px solid #fca5a5', color: '#b91c1c' }}>
            <p className="flex gap-1.5 font-semibold">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              {t(parsed.incompleteAll ? 'renta_calc.incomplete_all' : 'renta_calc.incomplete_title', { count: parsed.incompleteAssets.length })}
            </p>
            <ul className="list-disc pl-6 mt-1.5 space-y-0.5">
              {parsed.incompleteAssets.map((a) => <li key={a}>{label(a)}</li>)}
            </ul>
            <p className="mt-1.5" style={{ color: MUTED }}>{t('renta_calc.incomplete_why')}</p>
          </div>
        )}
        {result?.oversold?.length > 0 && (
          <p className="mt-2 text-[12px] flex gap-1.5" style={{ color: '#b91c1c' }}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{t('renta_calc.oversold', { count: result.oversold.length })}
          </p>
        )}
      </div>

      {result && (
        <CapitalGainsResult result={result} assetLabel={label} noSalesText={t('renta_calc.no_sales')} disclaimerText={parsed.incompleteAssets.length > 0 ? `${t('renta_calc.incomplete_total')} ${t('renta_calc.disclaimer')}` : t('renta_calc.disclaimer')} />
      )}

      <div className="p-5 md:p-8 grid md:grid-cols-2 gap-8" style={{ borderTop: `1px solid ${RULE}` }}>
        <div>
          <h3 className="font-ledger text-[11px] uppercase tracking-[0.2em] mb-3" style={{ color: FAINT }}>{t('renta_calc.limits_title')}</h3>
          <ul className="list-disc pl-5 space-y-1.5 text-[13px]" style={{ color: MUTED }}>
            {['limit_eur', 'limit_degiro', 'limit_isin', 'limit_history', 'limit_other'].map((k) => <li key={k}>{t(`renta_calc.${k}`)}</li>)}
          </ul>
        </div>
        <div>
          <h3 className="font-ledger text-[11px] uppercase tracking-[0.2em] mb-3" style={{ color: FAINT }}>{t('renta_calc.sources_title')}</h3>
          <ul className="list-disc pl-5 space-y-1.5 text-[13px]" style={{ color: MUTED }}>
            {SOURCES.map((s) => (
              <li key={s.key}><a href={s.href} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: ACCENT }}>{t(`renta_calc.${s.key}`)}</a></li>
            ))}
          </ul>
          <p className="mt-4 text-[12px]" style={{ color: FAINT }}>{t('renta_calc.updated', { date: updated })}</p>
        </div>
      </div>
    </div>
  );
}
