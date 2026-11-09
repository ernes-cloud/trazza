import React, { useState, createContext, useContext } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Maximize2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * True only while the widget is rendered inside the expand popup. The SAME child
 * element is rendered both inline and in the modal, so a widget that wants to
 * grow when expanded can't read a prop — it must read this context from a real
 * sub-component (rendered independently at each placement). Use <ExpandAware> for
 * inline JSX that isn't already its own component.
 */
export const ExpandedWidgetContext = createContext(false);

export function ExpandAware({ children }) {
  return children(useContext(ExpandedWidgetContext));
}

/**
 * Reusable widget wrapper that adds a top-right "expand" button. Clicking it
 * opens a large Ledger-styled popup rendering the SAME widget at full width.
 *
 * Usage:
 *   <ExpandableWidget title={t('portfolio_treemap.title')}>
 *     <PortfolioTreemap data={...} />
 *   </ExpandableWidget>
 *
 * Notes
 * - The button only appears on hover/focus and sits OUTSIDE the card, on its
 *   top-right corner over the grid gap: inside (top-2.5 right-2.5) it covered
 *   the widget's own header — the score's "Excelente" chip, the allocation
 *   tabs. On touch screens (no hover) it's hidden: there the widget is already
 *   full width and a sticky-hover button just sat on top of the content.
 * - The widget renders inline always; a second instance mounts inside the modal
 *   only while open. Data-prop widgets (treemap, calendars…) cost nothing extra;
 *   self-fetching ones (watchlist) simply re-fetch on expand.
 * - Recharts ResponsiveContainer fills the modal width, so charts/treemaps get
 *   far more room even when their height is fixed.
 */
export default function ExpandableWidget({ title, children, className = '' }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className={`relative group/expand h-full [&>div]:h-full ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('common.expand')}
        title={t('common.expand')}
        className="absolute -top-2.5 -right-2.5 z-30 p-1.5 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-500/50 shadow-md opacity-0 group-hover/expand:opacity-100 focus-visible:opacity-100 transition-all [@media(hover:none)]:hidden"
      >
        <Maximize2 className="w-3.5 h-3.5" />
      </button>

      {children}

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-100 bg-black/60 backdrop-blur-xs data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            className="fixed left-1/2 top-1/2 z-101 -translate-x-1/2 -translate-y-1/2 w-[96vw] max-w-6xl h-[90vh] flex flex-col bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200/80 dark:border-slate-700/40 shrink-0 bg-white dark:bg-slate-950">
              <DialogPrimitive.Title className="font-display text-lg font-black text-slate-900 dark:text-white tracking-tight">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close
                aria-label={t('common.close')}
                title={t('common.close')}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
              >
                <X className="w-4 h-4" />
              </DialogPrimitive.Close>
            </div>

            {/* Body — the widget at full width; ledger texture behind it */}
            <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 ledger-grid [&>div]:h-full">
              <ExpandedWidgetContext.Provider value={true}>
                {open && children}
              </ExpandedWidgetContext.Provider>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
