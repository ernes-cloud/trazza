import React, { useState, useEffect } from 'react';
import { Bell, BellRing, Loader2, TrendingUp, TrendingDown, ArrowUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useToast } from '@/components/ui/use-toast';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * Toolbar button + dialog to configure a portfolio price alert SCOPED to the
 * currently selected broker (or "all brokers"): notify (in-app + email via the
 * cron) when that scope's daily change crosses ±threshold, in a chosen
 * direction. One alert per (user, scope) in portfolio_alerts; evaluated by
 * server notificationCron.
 *
 * @param scope       'general' (all brokers) or a broker id — the alert key.
 * @param scopeLabel  human label for the scope (broker name / "all brokers").
 */
export default function PortfolioAlertButton({ scope = 'general', scopeLabel }) {
  const { t } = useTranslation();
  const { user } = useSupabaseAuth();
  const { toast } = useToast();

  const [open, setOpen]           = useState(false);
  const [saving, setSaving]       = useState(false);
  const [enabled, setEnabled]     = useState(false);
  const [threshold, setThreshold] = useState('5');
  const [direction, setDirection] = useState('both');
  const [active, setActive]       = useState(false);   // drives the toolbar accent/dot

  // Reload whenever the user OR the selected scope (broker) changes.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    supabase
      .from('portfolio_alerts')
      .select('enabled, threshold_pct, direction')
      .eq('user_id', user.id)
      .eq('scope', scope)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) {
          setEnabled(data.enabled);
          setThreshold(String(data.threshold_pct));
          setDirection(data.direction);
          setActive(data.enabled);
        } else {
          // No alert for this scope yet — show defaults.
          setEnabled(false);
          setThreshold('5');
          setDirection('both');
          setActive(false);
        }
      });
    return () => { cancelled = true; };
  }, [user?.id, scope]);

  const save = async () => {
    const pct = parseFloat(threshold);
    if (enabled && (isNaN(pct) || pct <= 0 || pct > 100)) {
      toast({ variant: 'destructive', title: t('dashboard.alert_invalid') });
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('portfolio_alerts').upsert({
      user_id: user.id,
      scope,
      enabled,
      threshold_pct: isNaN(pct) ? 5 : pct,
      direction,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,scope' });
    setSaving(false);
    if (error) {
      toast({ variant: 'destructive', title: t('common.error_save'), description: error.message });
      return;
    }
    setActive(enabled);
    setOpen(false);
    toast({ title: enabled ? t('dashboard.alert_saved_on') : t('dashboard.alert_saved_off') });
  };

  const DIRS = [
    { v: 'up',   label: t('dashboard.alert_dir_up'),   Icon: TrendingUp },
    { v: 'down', label: t('dashboard.alert_dir_down'), Icon: TrendingDown },
    { v: 'both', label: t('dashboard.alert_dir_both'), Icon: ArrowUpDown },
  ];

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={t('dashboard.alert_title')}
        className={`relative flex items-center gap-1.5 backdrop-blur-md border rounded-full px-3 py-2 shadow-xs shadow-slate-900/5 text-xs font-bold transition-colors ${
          active
            ? 'bg-blue-50 dark:bg-blue-500/15 border-blue-200 dark:border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/25'
            : 'bg-white/95 dark:bg-slate-800/95 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
        }`}
      >
        {active ? <BellRing className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />}
        <span className="hidden sm:inline">{t('dashboard.alert_button')}</span>
        {active && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 ring-2 ring-white dark:ring-slate-900" />}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-lg font-black tracking-tight">{t('dashboard.alert_title')}</DialogTitle>
            <DialogDescription className="text-sm text-slate-400">{t('dashboard.alert_desc')}</DialogDescription>
          </DialogHeader>

          {scopeLabel && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400 font-medium">{t('dashboard.alert_applies_to')}</span>
              <span className="px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400 font-bold">{scopeLabel}</span>
            </div>
          )}

          <div className="space-y-4 py-2">
            {/* Enable toggle */}
            <button
              type="button"
              onClick={() => setEnabled(e => !e)}
              className="w-full flex items-center justify-between px-3.5 py-3 rounded-xl border border-slate-200/80 dark:border-slate-700/40 bg-slate-50 dark:bg-slate-900/40"
            >
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('dashboard.alert_enable')}</span>
              <span className={`relative w-10 h-6 rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600'}`}>
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-4' : ''}`} />
              </span>
            </button>

            {/* Direction */}
            <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{t('dashboard.alert_direction')}</p>
              <div className="flex gap-1.5">
                {DIRS.map(({ v, label, Icon }) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setDirection(v)}
                    className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-xl text-[11px] font-bold border transition-all ${
                      direction === v
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-blue-400'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Threshold */}
            <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{t('dashboard.alert_threshold')}</p>
              <div className="relative">
                <input
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={threshold}
                  onChange={e => setThreshold(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && save()}
                  className="w-full pl-4 pr-9 py-3 rounded-xl border border-slate-200/80 dark:border-slate-700/40 bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-sm font-bold tabular-nums outline-hidden focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">%</span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5">{t('dashboard.alert_hint')}</p>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={save} disabled={saving} className="w-full bg-blue-600 hover:bg-blue-700 rounded-xl font-bold text-sm gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
