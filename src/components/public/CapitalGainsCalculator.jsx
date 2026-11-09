import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { parseAmountInput } from '@/lib/parseAmountInput';
import { computeCapitalGains } from '@/services/publicTools/capitalGains';
import { localTodayIso } from '@/lib/dates';
import { TOOL_COLORS } from './PublicToolShell';
import { NumberField, makeMoney } from './toolUi';
import CapitalGainsResult from './CapitalGainsResult';

const { TEXT, FAINT, RULE, ACCENT } = TOOL_COLORS;
const INPUT = 'w-full min-w-0 rounded-lg bg-white px-2.5 py-2 text-[14px] outline-hidden focus:ring-2 focus:ring-blue-500/40';

// Ejemplo de partida: dos compras y una venta que consume la primera entera y
// parte de la segunda, para que el FIFO se vea en el resultado.
const EXAMPLE = [
  { asset: 'ACME', type: 'buy', date: '2024-02-12', qty: '20', price: '50', fee: '2' },
  { asset: 'ACME', type: 'buy', date: '2024-09-03', qty: '10', price: '62', fee: '2' },
  { asset: 'ACME', type: 'sell', date: '2025-05-20', qty: '25', price: '71', fee: '2' },
];

/** Celda de la tabla con su etiqueta visible solo en móvil (en escritorio la dan las cabeceras). */
const Cell = ({ label, className = '', children }) => (
  <label className={`block min-w-0 ${className}`}>
    <span className="md:hidden block font-ledger text-[10px] uppercase tracking-[0.14em] mb-1" style={{ color: FAINT }}>{label}</span>
    {children}
  </label>
);

/**
 * Calculadora de plusvalías: compras y ventas → ganancia FIFO por venta, regla
 * de los dos meses y cuota estimada por año. La matemática está en
 * services/publicTools/capitalGains.js (testeada); aquí solo el formulario.
 */
export default function CapitalGainsCalculator() {
  const { t, i18n } = useTranslation();
  const { locale } = makeMoney(i18n.language);
  const nextId = useRef(EXAMPLE.length);
  const [rows, setRows] = useState(() => EXAMPLE.map((r, i) => ({ ...r, id: `r${i}` })));
  const [other, setOther] = useState('0');

  const update = (id, field, value) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  const remove = (id) => setRows((prev) => prev.filter((r) => r.id !== id));
  const add = (type) => setRows((prev) => {
    const last = prev[prev.length - 1];
    nextId.current += 1;
    // "Hoy" al añadir la fila, nunca en una constante de módulo (ver CLAUDE.md).
    return [...prev, { id: `r${nextId.current}`, asset: last?.asset || '', type, date: localTodayIso(), qty: '', price: '', fee: '' }];
  });

  const result = useMemo(() => computeCapitalGains(
    rows.map((r) => ({
      id: r.id,
      asset: r.asset,
      type: r.type,
      date: r.date,
      qty: parseAmountInput(r.qty) ?? NaN,
      price: parseAmountInput(r.price) ?? NaN,
      fee: parseAmountInput(r.fee) ?? 0,
    })),
    { otherSavingsIncome: parseAmountInput(other) ?? 0 },
  ), [rows, other]);

  const invalidIds = new Set(result.invalid.map((i) => i.id));
  const oversoldIds = new Map(result.oversold.map((o) => [o.id, o.missing]));
  const qtyFmt = (v) => v.toLocaleString(locale, { maximumFractionDigits: 6 });

  return (
    <div className="bg-white">
      {/* ── Operaciones ── */}
      <div className="p-5 md:p-8" style={{ borderBottom: `1px solid ${RULE}` }}>
        <h2 className="text-[15px] font-bold mb-1" style={{ color: TEXT }}>{t('cg_calc.ops_title')}</h2>
        <p className="text-[13px] mb-4" style={{ color: FAINT }}>{t('cg_calc.ops_hint')}</p>

        <div className="hidden md:grid grid-cols-[1.3fr_0.9fr_1.1fr_0.8fr_0.9fr_0.8fr_auto] gap-2 px-1 mb-1.5 font-ledger text-[10px] uppercase tracking-[0.16em]" style={{ color: FAINT }}>
          <span>{t('cg_calc.col_asset')}</span><span>{t('cg_calc.col_type')}</span><span>{t('cg_calc.col_date')}</span>
          <span>{t('cg_calc.col_qty')}</span><span>{t('cg_calc.col_price')}</span><span>{t('cg_calc.col_fee')}</span><span className="w-8" />
        </div>

        <div className="space-y-2">
          {rows.map((r) => {
            const bad = invalidIds.has(r.id);
            const border = { border: `1px solid ${bad ? '#fca5a5' : RULE}` };
            return (
              <div key={r.id} className="grid grid-cols-2 md:grid-cols-[1.3fr_0.9fr_1.1fr_0.8fr_0.9fr_0.8fr_auto] gap-2 rounded-xl md:rounded-none p-3 md:p-0 border border-slate-200 md:border-0">
                <Cell label={t('cg_calc.col_asset')} className="col-span-2 md:col-span-1"><input aria-label={t('cg_calc.col_asset')} value={r.asset} onChange={(e) => update(r.id, 'asset', e.target.value)} placeholder={t('cg_calc.asset_placeholder')} className={INPUT} style={{ ...border, color: TEXT }} /></Cell>
                <Cell label={t('cg_calc.col_type')}><select aria-label={t('cg_calc.col_type')} value={r.type} onChange={(e) => update(r.id, 'type', e.target.value)} className={INPUT} style={{ ...border, color: r.type === 'sell' ? '#b45309' : ACCENT, fontWeight: 600 }}>
                  <option value="buy">{t('cg_calc.type_buy')}</option>
                  <option value="sell">{t('cg_calc.type_sell')}</option>
                </select></Cell>
                <Cell label={t('cg_calc.col_date')}><input aria-label={t('cg_calc.col_date')} type="date" value={r.date} onChange={(e) => update(r.id, 'date', e.target.value)} className={INPUT} style={{ ...border, color: TEXT }} /></Cell>
                <Cell label={t('cg_calc.col_qty')}><input aria-label={t('cg_calc.col_qty')} type="text" inputMode="decimal" value={r.qty} onChange={(e) => update(r.id, 'qty', e.target.value)} placeholder="0" className={`${INPUT} tabular-nums`} style={{ ...border, color: TEXT }} /></Cell>
                <Cell label={t('cg_calc.col_price')}><input aria-label={t('cg_calc.col_price')} type="text" inputMode="decimal" value={r.price} onChange={(e) => update(r.id, 'price', e.target.value)} placeholder="0,00" className={`${INPUT} tabular-nums`} style={{ ...border, color: TEXT }} /></Cell>
                <Cell label={t('cg_calc.col_fee')}><input aria-label={t('cg_calc.col_fee')} type="text" inputMode="decimal" value={r.fee} onChange={(e) => update(r.id, 'fee', e.target.value)} placeholder="0,00" className={`${INPUT} tabular-nums`} style={{ ...border, color: TEXT }} /></Cell>
                <button type="button" onClick={() => remove(r.id)} aria-label={t('cg_calc.remove')} title={t('cg_calc.remove')} className="w-8 h-9 flex items-center justify-center rounded-lg justify-self-end self-end hover:bg-rose-50" style={{ color: FAINT }}>
                  <Trash2 className="w-4 h-4" />
                </button>
                {oversoldIds.has(r.id) && (
                  <p className="col-span-2 md:col-span-7 text-[12px] flex items-center gap-1.5" style={{ color: '#b91c1c' }}>
                    <AlertTriangle className="w-3.5 h-3.5" />{t('cg_calc.oversold', { qty: qtyFmt(oversoldIds.get(r.id)) })}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => add('buy')} className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold" style={{ border: `1px solid ${RULE}`, color: ACCENT }}>
            <Plus className="w-4 h-4" />{t('cg_calc.add_buy')}
          </button>
          <button type="button" onClick={() => add('sell')} className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold" style={{ border: `1px solid ${RULE}`, color: '#b45309' }}>
            <Plus className="w-4 h-4" />{t('cg_calc.add_sell')}
          </button>
        </div>
        {result.invalid.length > 0 && (
          <p className="mt-3 text-[12px]" style={{ color: '#b91c1c' }}>{t('cg_calc.invalid', { count: result.invalid.length })}</p>
        )}
        <div className="mt-6 max-w-sm">
          <NumberField id="cg-other" label={t('cg_calc.f_other')} hint={t('cg_calc.f_other_hint')} value={other} onChange={setOther} suffix="€" />
        </div>
      </div>

      <CapitalGainsResult result={result} />
    </div>
  );
}
