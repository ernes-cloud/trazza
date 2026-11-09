import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Sun, Moon, Mail, Upload, Check, PenLine, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { supabase } from '@/lib/customSupabaseClient';
import { setLanguagePreference } from '@/i18n';
import { preferredCurrencyOf } from '@/lib/preferredCurrency';
import { WELCOME_CURRENCIES, WELCOME_LS_KEY } from '@/lib/welcomeSetup';
import { ALL_CURRENCIES } from '@/components/CurrencySelector';

const LANGS = [{ code: 'es', label: 'Español' }, { code: 'en', label: 'English' }];

const Choice = ({ selected, onClick, children, className = '' }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={selected}
    className={`relative flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors ${
      selected
        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-500'
        : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600'
    } ${className}`}
  >
    {children}
    {selected && <Check className="w-3.5 h-3.5 absolute top-1.5 right-1.5" />}
  </button>
);

const StartOption = ({ icon: Icon, title, desc, onClick, disabled, primary = false }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`group flex items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-60 ${
      primary
        ? 'border-blue-500 bg-blue-600 text-white hover:bg-blue-700'
        : 'border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-500 text-slate-900 dark:text-white'
    }`}
  >
    <span className={`shrink-0 rounded-lg p-2 ${primary ? 'bg-white/15' : 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'}`}>
      <Icon className="w-4 h-4" />
    </span>
    <span className="flex-1 min-w-0">
      <span className="block text-sm font-bold">{title}</span>
      <span className={`block text-xs mt-0.5 ${primary ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>{desc}</span>
    </span>
    <ChevronRight className={`w-4 h-4 shrink-0 ${primary ? 'text-blue-100' : 'text-slate-400'}`} />
  </button>
);

const Section = ({ title, hint, children }) => (
  <div>
    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">{title}</p>
    {children}
    {hint && <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">{hint}</p>}
  </div>
);

/**
 * Bienvenida de una cuenta nueva: idioma, divisa, tema y avisos por correo, y
 * de ahí a empezar: importar el extracto o añadir una posición a mano (para
 * probar Trazza en segundos sin buscar ningún fichero). Cuándo se abre lo decide `shouldShowWelcome`
 * (lib/welcomeSetup). Idioma y tema se aplican AL MOMENTO (se ve el cambio);
 * todo se guarda al terminar, en una sola escritura de preferencias.
 *
 * @param {{ open: boolean, onClose: () => void, darkMode: boolean, onPreviewDarkMode: (dark: boolean) => void }} props
 */
export default function WelcomeSetupDialog({ open, onClose, darkMode, onPreviewDarkMode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { preferences, savePreferences } = useUserPreferences();

  const [lang, setLang] = useState(() => ((i18n.language || '').startsWith('en') ? 'en' : 'es'));
  const [currency, setCurrency] = useState(() => preferredCurrencyOf(preferences));
  const [emailOn, setEmailOn] = useState(() => preferences?.email_notifications_enabled !== false);
  const [saving, setSaving] = useState(false);

  const pickLang = (code) => {
    setLang(code);
    setLanguagePreference(code); // el diálogo se traduce en el acto
  };

  /** @param {{ start?: 'import'|'position'|null }} opts */
  const finish = async ({ start = null }) => {
    setSaving(true);
    try { localStorage.setItem(WELCOME_LS_KEY, 'true'); } catch { /* modo privado */ }
    const { error } = await savePreferences({
      preferred_currency: currency,
      dark_mode: darkMode,
      language: lang,
      email_notifications_enabled: emailOn,
    });
    // La marca va en los metadatos de la cuenta (ver lib/welcomeSetup). Si
    // falla, el localStorage evita que vuelva en este navegador.
    const { error: metaError } = await supabase.auth.updateUser({
      data: { welcome_completed_at: new Date().toISOString() },
    });
    setSaving(false);
    if (error || metaError) {
      toast({ variant: 'destructive', title: t('common.error_save'), description: (error || metaError)?.message });
    } else {
      toast({ title: t('welcome.saved') });
    }
    onClose();
    if (start) navigate(`/app/brokers?start=${start}`);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) finish({}); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto dark:bg-slate-900 border-none">
        <DialogHeader>
          <DialogTitle className="text-xl dark:text-white">{t('welcome.title')}</DialogTitle>
          <DialogDescription>{t('welcome.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <Section title={t('welcome.language')}>
            <div className="grid grid-cols-2 gap-2">
              {LANGS.map(({ code, label }) => (
                <Choice key={code} selected={lang === code} onClick={() => pickLang(code)}>{label}</Choice>
              ))}
            </div>
          </Section>

          <Section title={t('welcome.currency')} hint={t('welcome.currency_hint')}>
            <div className="grid grid-cols-4 gap-2">
              {WELCOME_CURRENCIES.map((code) => (
                <Choice key={code} selected={currency === code} onClick={() => setCurrency(code)}>{code}</Choice>
              ))}
            </div>
            {/* Todas las de Ajustes. <select> nativo a propósito: el desplegable
                de CurrencySelector va en un portal fuera del diálogo, y un
                Dialog modal de Radix bloquea los clics y el foco ahí fuera. */}
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              aria-label={t('welcome.currency_all')}
              className={`mt-2 w-full rounded-xl border px-3 py-2.5 text-sm font-semibold bg-white dark:bg-slate-800 outline-hidden focus:ring-2 focus:ring-blue-500 ${
                WELCOME_CURRENCIES.includes(currency)
                  ? 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
                  : 'border-blue-500 text-blue-700 dark:text-blue-300'
              }`}
            >
              {WELCOME_CURRENCIES.includes(currency) && <option value={currency}>{t('welcome.currency_all')}</option>}
              {ALL_CURRENCIES.map(({ code, name }) => (
                <option key={code} value={code}>{code} — {name}</option>
              ))}
            </select>
          </Section>

          <Section title={t('welcome.theme')}>
            <div className="grid grid-cols-2 gap-2">
              <Choice selected={!darkMode} onClick={() => onPreviewDarkMode(false)}>
                <Sun className="w-4 h-4" />{t('welcome.theme_light')}
              </Choice>
              <Choice selected={darkMode} onClick={() => onPreviewDarkMode(true)}>
                <Moon className="w-4 h-4" />{t('welcome.theme_dark')}
              </Choice>
            </div>
          </Section>

          <Section title={t('welcome.emails')}>
            <label className="flex items-start gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={emailOn}
                onChange={(e) => setEmailOn(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-blue-600"
              />
              <span className="text-sm text-slate-700 dark:text-slate-200">
                <span className="inline-flex items-center gap-1.5 font-semibold"><Mail className="w-3.5 h-3.5" />{t('welcome.emails_label')}</span>
                <span className="block text-xs text-slate-400 mt-0.5">{t('welcome.emails_hint')}</span>
              </span>
            </label>
          </Section>
        </div>

        <div className="pt-1">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">{t('welcome.start_title')}</p>
          <div className="grid sm:grid-cols-2 gap-2">
            <StartOption
              icon={Upload} disabled={saving} primary
              title={t('welcome.import')} desc={t('welcome.import_desc')}
              onClick={() => finish({ start: 'import' })}
            />
            <StartOption
              icon={PenLine} disabled={saving}
              title={t('welcome.manual')} desc={t('welcome.manual_desc')}
              onClick={() => finish({ start: 'position' })}
            />
          </div>
          <div className="text-center mt-3">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => finish({})} className="text-slate-500">
              {t('welcome.explore')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
