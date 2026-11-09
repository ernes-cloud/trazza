import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, Check } from 'lucide-react';

export const ALL_CURRENCIES = [
  { code: 'EUR', name: 'Euro' },
  { code: 'USD', name: 'US Dollar' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'HKD', name: 'Hong Kong Dollar' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'CNY', name: 'Chinese Yuan' },
  { code: 'TWD', name: 'Taiwan Dollar' },
  { code: 'KRW', name: 'South Korean Won' },
  { code: 'INR', name: 'Indian Rupee' },
  { code: 'MYR', name: 'Malaysian Ringgit' },
  { code: 'THB', name: 'Thai Baht' },
  { code: 'IDR', name: 'Indonesian Rupiah' },
  { code: 'PHP', name: 'Philippine Peso' },
  { code: 'VND', name: 'Vietnamese Dong' },
  { code: 'BRL', name: 'Brazilian Real' },
  { code: 'MXN', name: 'Mexican Peso' },
  { code: 'CLP', name: 'Chilean Peso' },
  { code: 'COP', name: 'Colombian Peso' },
  { code: 'PEN', name: 'Peruvian Sol' },
  { code: 'ARS', name: 'Argentine Peso' },
  { code: 'ZAR', name: 'South African Rand' },
  { code: 'NGN', name: 'Nigerian Naira' },
  { code: 'KES', name: 'Kenyan Shilling' },
  { code: 'EGP', name: 'Egyptian Pound' },
  { code: 'MAD', name: 'Moroccan Dirham' },
  { code: 'TRY', name: 'Turkish Lira' },
  { code: 'PLN', name: 'Polish Zloty' },
  { code: 'CZK', name: 'Czech Koruna' },
  { code: 'HUF', name: 'Hungarian Forint' },
  { code: 'RON', name: 'Romanian Leu' },
  { code: 'BGN', name: 'Bulgarian Lev' },
  { code: 'ISK', name: 'Icelandic Krona' },
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'SAR', name: 'Saudi Riyal' },
  { code: 'QAR', name: 'Qatari Riyal' },
  { code: 'KWD', name: 'Kuwaiti Dinar' },
  { code: 'BHD', name: 'Bahraini Dinar' },
  { code: 'OMR', name: 'Omani Rial' },
  { code: 'JOD', name: 'Jordanian Dinar' },
  { code: 'ILS', name: 'Israeli Shekel' },
  { code: 'PKR', name: 'Pakistani Rupee' },
];

export default function CurrencySelector({ value, onChange, className = '' }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [style, setStyle] = useState({});
  const triggerRef = useRef(null);
  const dropdownRef = useRef(null);
  const inputRef = useRef(null);

  const filtered = ALL_CURRENCIES.filter(c =>
    c.code.toLowerCase().includes(search.toLowerCase()) ||
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const selected = ALL_CURRENCIES.find(c => c.code === value);

  // Position the portal dropdown below the trigger button
  const reposition = () => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setStyle({
      position: 'fixed',
      top: r.bottom + 4,
      left: r.left,
      width: Math.max(r.width, 288),
      zIndex: 9999,
    });
  };

  useEffect(() => {
    if (!open) return;
    reposition();
    setSearch('');
    setTimeout(() => inputRef.current?.focus(), 40);

    const onMouseDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (dropdownRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };

    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll, { capture: true });
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={triggerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between gap-2 w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm font-semibold text-slate-800 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 hover:border-slate-300 dark:hover:border-slate-500 transition-colors"
      >
        <span>{selected ? `${selected.code} — ${selected.name}` : value}</span>
        <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          style={style}
          className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-2xl overflow-hidden"
        >
          <div className="p-2 border-b border-slate-100 dark:border-slate-700/60">
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700/40">
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar divisa..."
                className="flex-1 text-xs bg-transparent border-none outline-hidden text-slate-700 dark:text-slate-300 placeholder-slate-400"
              />
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-xs text-slate-400 text-center">Sin resultados</p>
            ) : filtered.map(c => (
              <button
                key={c.code}
                type="button"
                onClick={() => { onChange(c.code); setOpen(false); }}
                className={`w-full flex items-center justify-between px-4 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700/60 transition-colors ${
                  c.code === value
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                    : 'text-slate-700 dark:text-slate-300'
                }`}
              >
                <span><span className="font-bold">{c.code}</span> — {c.name}</span>
                {c.code === value && <Check className="w-3.5 h-3.5 shrink-0" />}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
