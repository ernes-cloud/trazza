import { Bell, CheckCircle, AlertCircle, Calendar, Zap, TrendingUp, Newspaper, BarChart3 } from 'lucide-react';

/**
 * Returns icon and color config for a notification.
 * Supports both a `type` field (preferred, forward-compatible) and
 * legacy emoji-prefixed titles for backwards compatibility.
 */
export function getNotifConfig(title = '', type = null) {
  // Forward-compatible: explicit type field wins
  if (type) {
    switch (type) {
      case 'success':
        return { Icon: CheckCircle, color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-l-emerald-400 dark:border-l-emerald-500', unreadBg: 'bg-emerald-50/60 dark:bg-emerald-900/10 border-emerald-100 dark:border-emerald-800/30' };
      case 'error':
        return { Icon: AlertCircle, color: 'text-rose-500', bg: 'bg-rose-50 dark:bg-rose-900/20', border: 'border-l-rose-400 dark:border-l-rose-500', unreadBg: 'bg-rose-50/60 dark:bg-rose-900/10 border-rose-100 dark:border-rose-800/30' };
      case 'warning':
        return { Icon: Zap, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-l-amber-400 dark:border-l-amber-500', unreadBg: 'bg-amber-50/60 dark:bg-amber-900/10 border-amber-100 dark:border-amber-800/30' };
      case 'dividend':
        return { Icon: Calendar, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-900/20', border: 'border-l-blue-400 dark:border-l-blue-500', unreadBg: 'bg-blue-50/60 dark:bg-blue-900/10 border-blue-100 dark:border-blue-800/30' };
      case 'earnings':
        return { Icon: BarChart3, color: 'text-cyan-500', bg: 'bg-cyan-50 dark:bg-cyan-900/20', border: 'border-l-cyan-400 dark:border-l-cyan-500', unreadBg: 'bg-cyan-50/60 dark:bg-cyan-900/10 border-cyan-100 dark:border-cyan-800/30' };
      case 'alert':
        return { Icon: TrendingUp, color: 'text-purple-500', bg: 'bg-purple-50 dark:bg-purple-900/20', border: 'border-l-purple-400 dark:border-l-purple-500', unreadBg: 'bg-purple-50/60 dark:bg-purple-900/10 border-purple-100 dark:border-purple-800/30' };
      case 'blog':
        return { Icon: Newspaper, color: 'text-indigo-500', bg: 'bg-indigo-50 dark:bg-indigo-900/20', border: 'border-l-indigo-400 dark:border-l-indigo-500', unreadBg: 'bg-indigo-50/60 dark:bg-indigo-900/10 border-indigo-100 dark:border-indigo-800/30' };
      default:
        break;
    }
  }

  // Legacy: emoji-prefixed titles
  if (title.includes('📰')) return { Icon: Newspaper, color: 'text-indigo-500', bg: 'bg-indigo-50 dark:bg-indigo-900/20', border: 'border-l-indigo-400 dark:border-l-indigo-500', unreadBg: 'bg-indigo-50/60 dark:bg-indigo-900/10 border-indigo-100 dark:border-indigo-800/30' };
  if (title.includes('✅')) return { Icon: CheckCircle, color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-l-emerald-400 dark:border-l-emerald-500', unreadBg: 'bg-emerald-50/60 dark:bg-emerald-900/10 border-emerald-100 dark:border-emerald-800/30' };
  if (title.includes('❌')) return { Icon: AlertCircle, color: 'text-rose-500', bg: 'bg-rose-50 dark:bg-rose-900/20', border: 'border-l-rose-400 dark:border-l-rose-500', unreadBg: 'bg-rose-50/60 dark:bg-rose-900/10 border-rose-100 dark:border-rose-800/30' };
  if (title.includes('⚡')) return { Icon: Zap, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-l-amber-400 dark:border-l-amber-500', unreadBg: 'bg-amber-50/60 dark:bg-amber-900/10 border-amber-100 dark:border-amber-800/30' };
  if (title.includes('📅') || title.includes('Dividendo')) return { Icon: Calendar, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-900/20', border: 'border-l-blue-400 dark:border-l-blue-500', unreadBg: 'bg-blue-50/60 dark:bg-blue-900/10 border-blue-100 dark:border-blue-800/30' };
  if (title.includes('📈') || title.includes('Alerta') || title.includes('precio')) return { Icon: TrendingUp, color: 'text-purple-500', bg: 'bg-purple-50 dark:bg-purple-900/20', border: 'border-l-purple-400 dark:border-l-purple-500', unreadBg: 'bg-purple-50/60 dark:bg-purple-900/10 border-purple-100 dark:border-purple-800/30' };

  return { Icon: Bell, color: 'text-slate-400', bg: 'bg-slate-100 dark:bg-slate-800/60', border: 'border-l-slate-300 dark:border-l-slate-600', unreadBg: 'bg-blue-50/40 dark:bg-blue-900/10 border-blue-100 dark:border-blue-800/30' };
}
