import React from 'react';
import { useTranslation } from 'react-i18next';
import { Reorder } from 'framer-motion';
import { Plus, Settings2, GripVertical } from 'lucide-react';

// Touch devices get pan-x + no drag-reorder: framer's drag listener otherwise
// swallows horizontal swipes on the short tab strip (documented behaviour —
// keep in sync with the identical constant in CarteraPage).
const IS_COARSE_POINTER = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches === true;

/**
 * Broker tab bar: pinned "General" tab + drag-reorderable broker tabs + add button.
 * Pure presentation — broker creation (Supabase insert) lives in the parent
 * (handleAddBroker); reorder only reports the new id order.
 */
const BrokerTabBar = ({
  brokers,
  selectedBrokerId,
  onSelectBroker,
  onReorder,
  onEditBroker,
  onAddBroker,
}) => {
  const { t } = useTranslation();
  return (
    <div className="relative">
      {/* touch-pan-x: commit touches starting here to horizontal panning (the strip
          is short — without it the browser claims diagonal swipes for page scroll);
          overscroll-x-contain: don't chain the gesture into browser back-navigation */}
      <div className="flex items-center gap-1.5 sm:gap-2 pb-2 border-b border-slate-200 dark:border-slate-800/80 overflow-x-auto no-scrollbar scroll-smooth touch-pan-x overscroll-x-contain">
        {/* General Portfolio - Pinned */}
        <button
          onClick={() => onSelectBroker('general')}
          className={`shrink-0 px-3 sm:px-6 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all duration-300 whitespace-nowrap ${selectedBrokerId === 'general'
            ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25 ring-2 ring-blue-500/10'
            : 'bg-white dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-slate-200 dark:border-slate-700/50'
            }`}
        >
          {t('cartera.general_portfolio')}
        </button>

        {/* Draggable Brokers */}
        <Reorder.Group
          axis="x"
          values={brokers}
          onReorder={onReorder}
          className="flex items-center gap-1.5 sm:gap-2"
        >
          {brokers?.map((broker) => (
            <Reorder.Item
              key={broker.id}
              value={broker}
              dragListener={!IS_COARSE_POINTER && selectedBrokerId !== broker.id}
              // Explicit touchAction wins over the pan-y framer applies for x-drag,
              // which otherwise swallows horizontal swipes on the tab strip.
              style={IS_COARSE_POINTER ? { touchAction: 'pan-x' } : undefined}
              className="relative group shrink-0"
            >
              <button
                onClick={() => onSelectBroker(broker.id)}
                className={`px-3 sm:px-6 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all duration-300 flex items-center gap-1.5 sm:gap-2 whitespace-nowrap ${selectedBrokerId === broker.id
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 shadow-lg shadow-slate-900/20 dark:shadow-white/10'
                  : 'bg-white dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-slate-200 dark:border-slate-700/50 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
              >
                <GripVertical className="hidden sm:block w-3 h-3 opacity-0 group-hover:opacity-40 transition-opacity" />
                {broker.name}
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditBroker(broker);
                  }}
                  className={`p-1 rounded-md transition-colors ${
                    selectedBrokerId === broker.id
                      ? 'hover:bg-white/20 dark:hover:bg-black/20'
                      : 'hover:bg-slate-200 dark:hover:bg-slate-700'
                  } sm:opacity-0 sm:group-hover:opacity-60 hover:opacity-100!`}
                >
                  <Settings2 className="w-3 h-3 sm:w-3.5 sm:h-3.5 opacity-60 sm:opacity-100" />
                </div>
              </button>
            </Reorder.Item>
          ))}
        </Reorder.Group>

        <button
          onClick={onAddBroker}
          className="shrink-0 p-2 sm:p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-blue-500 border border-slate-200 dark:border-slate-700/50 transition-all hover:border-blue-200 dark:hover:border-blue-900/50"
        >
          <Plus className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>
      </div>
      {/* Gradient fade — scroll affordance on mobile */}
      <div className="sm:hidden absolute right-0 top-0 bottom-2 w-8 bg-linear-to-l from-white dark:from-slate-900 to-transparent pointer-events-none" />
    </div>
  );
};

export default BrokerTabBar;
