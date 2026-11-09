import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import { useTranslation } from 'react-i18next';
import { Save, Loader2, Eye, EyeOff, User, Globe, Plug, Mail } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { DEFAULT_CURRENCY } from '@/lib/preferredCurrency';
import { useToast } from '@/components/ui/use-toast';
import CurrencySelector from '@/components/CurrencySelector';

const SectionCard = ({ icon: Icon, title, description, children }) => (
  <div className="bg-white dark:bg-slate-800/80 rounded-2xl border border-slate-200/80 dark:border-slate-700/40 shadow-xs overflow-hidden">
    <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-900/20">
      <div className="p-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-xs">
        <Icon className="w-4 h-4 text-slate-500 dark:text-slate-400" />
      </div>
      <div>
        <p className="text-sm font-bold text-slate-900 dark:text-white">{title}</p>
        {description && <p className="text-xs text-slate-500 dark:text-slate-400">{description}</p>}
      </div>
    </div>
    <div className="p-6">{children}</div>
  </div>
);

const ApiKeyField = ({ label, value, onChange, placeholder, hint, href }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-2">
      <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 block">{label}</label>
      {hint && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {hint}{' '}
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              {href.replace('https://', '')}
            </a>
          )}
        </p>
      )}
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className="w-full pr-10 px-4 py-2.5 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-hidden transition"
        />
        <button type="button" onClick={() => setShow(s => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
};

const SettingsPage = () => {
  const { t } = useTranslation();
  const { user } = useSupabaseAuth();
  const { toast } = useToast();
  const [localSettings, setLocalSettings] = useState(null);
  const [saved, setSaved] = useState(false);

  // La fila compartida (UserPreferencesContext, select('*')); los defaults
  // rellenan las columnas que la fila aún no tenga.
  const { preferences, loading: isLoading, savePreferences } = useUserPreferences();
  const dbSettings = preferences
    ? { preferred_currency: DEFAULT_CURRENCY, eodhd_api_key: '', email_notifications_enabled: true, ...preferences }
    : null;

  const settings = localSettings ?? dbSettings ?? { preferred_currency: DEFAULT_CURRENCY, eodhd_api_key: '', email_notifications_enabled: true, email_notify_dividends: true, email_notify_earnings: true, email_notify_alerts: true, email_notify_weekly_report: false };

  const saveMutation = useMutation({
    mutationFn: async (payload) => {
      const { error } = await savePreferences(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      setLocalSettings(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      toast({ title: t('settings.toast_saved_title'), description: t('settings.toast_saved_desc') });
    },
    onError: (e) => toast({ title: t('settings.toast_error_title'), description: e.message, variant: 'destructive' }),
  });

  const updateField = (field, value) => setLocalSettings(s => ({ ...settings, ...(s || {}), [field]: value }));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-16">
      <Helmet><title>{t('settings.page_title')}</title></Helmet>

      <div>
        <h1 className="font-display text-2xl font-black tracking-tight text-slate-900 dark:text-white">{t('settings.title')}</h1>
        <p className="text-slate-500 dark:text-slate-400 mt-1 text-sm">{t('settings.subtitle')}</p>
      </div>

      <SectionCard icon={User} title={t('settings.account_title')} description={t('settings.account_desc')}>
        <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-700/50">
          <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
            <span className="text-white text-sm font-bold uppercase">{(user?.email?.[0] || 'U')}</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">{user?.email}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('settings.account_active')}</p>
          </div>
        </div>
      </SectionCard>

      <SectionCard icon={Globe} title={t('settings.currency_title')} description={t('settings.currency_desc')}>
        <CurrencySelector
          value={settings.preferred_currency}
          onChange={c => updateField('preferred_currency', c)}
        />
      </SectionCard>

      <SectionCard icon={Plug} title={t('settings.api_title')} description={t('settings.api_desc')}>
        <div className="space-y-5">
          <ApiKeyField
            label={t('settings.eodhd_label')}
            value={settings.eodhd_api_key}
            onChange={e => updateField('eodhd_api_key', e.target.value)}
            placeholder={t('settings.eodhd_placeholder')}
            hint={t('settings.eodhd_hint')}
            href="https://eodhd.com"
          />
        </div>
      </SectionCard>

      <SectionCard icon={Mail} title={t('settings.email_title')} description={t('settings.email_desc')}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-slate-900 dark:text-white">{t('settings.email_toggle_label')}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('settings.email_toggle_hint', { email: user?.email || '' })}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!!settings.email_notifications_enabled}
            onClick={() => updateField('email_notifications_enabled', !settings.email_notifications_enabled)}
            className={`relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
              settings.email_notifications_enabled
                ? 'bg-blue-600'
                : 'bg-slate-200 dark:bg-slate-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-xs transition-transform ${
                settings.email_notifications_enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {settings.email_notifications_enabled && (
          <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700/50 space-y-3">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t('settings.email_types_title')}</p>
            {[
              { field: 'email_notify_dividends', label: t('settings.email_notify_dividends') },
              { field: 'email_notify_earnings',  label: t('settings.email_notify_earnings') },
              { field: 'email_notify_alerts',    label: t('settings.email_notify_alerts') },
            ].map(({ field, label }) => (
              <label key={field} className="flex items-center gap-3 cursor-pointer group">
                <div
                  className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    settings[field]
                      ? 'bg-blue-600 border-blue-600'
                      : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-600 group-hover:border-blue-400'
                  }`}
                  onClick={() => updateField(field, !settings[field])}
                >
                  {settings[field] && (
                    <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
                <span
                  className="text-sm text-slate-700 dark:text-slate-300 select-none"
                  onClick={() => updateField(field, !settings[field])}
                >
                  {label}
                </span>
              </label>
            ))}
            <div className="pt-3 border-t border-slate-100 dark:border-slate-700/30">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">{t('settings.email_notify_section_global')}</p>
              {[
                { field: 'email_notify_weekly_report', label: t('settings.email_notify_weekly_report') },
              ].map(({ field, label }) => (
                <label key={field} className="flex items-center gap-3 cursor-pointer group mb-3">
                  <div
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                      settings[field]
                        ? 'bg-blue-600 border-blue-600'
                        : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-600 group-hover:border-blue-400'
                    }`}
                    onClick={() => updateField(field, !settings[field])}
                  >
                    {settings[field] && (
                      <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  <span
                    className="text-sm text-slate-700 dark:text-slate-300 select-none"
                    onClick={() => updateField(field, !settings[field])}
                  >
                    {label}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

      </SectionCard>

      <div className="flex justify-end">
        <Button
          onClick={() => saveMutation.mutate(settings)}
          disabled={saveMutation.isPending}
          className={`gap-2 min-w-[140px] transition-all ${saved ? 'bg-emerald-600 hover:bg-emerald-600' : ''}`}
        >
          {saveMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saved ? t('settings.saved_btn') : saveMutation.isPending ? t('settings.saving_btn') : t('settings.save_btn')}
        </Button>
      </div>
    </div>
  );
};

export default SettingsPage;
