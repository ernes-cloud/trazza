import React, { useMemo } from 'react';
import { parseInsightBlocks } from '@/lib/aiInsightFormat';

/**
 * Shared renderer for Trazza AI narratives (portfolio score, earnings…).
 * Parsing lives in @/lib/aiInsightFormat (pure + tested); this file only paints.
 */

// ── Inline markdown renderer (bold only) ─────────────────────────────────────
export function renderInline(text) {
  const chunks = String(text ?? '').split(/(\*\*[^*]+\*\*)/g);
  return chunks.map((chunk, i) =>
    chunk.startsWith('**') && chunk.endsWith('**')
      ? <strong key={i} className="font-semibold text-slate-700 dark:text-slate-200">{chunk.slice(2, -2)}</strong>
      : <React.Fragment key={i}>{chunk}</React.Fragment>
  );
}

/**
 * Compact block rendering — used where the narrative sits inside a card
 * (the earnings widget). The score modal keeps its own richer layout.
 */
export function AiInsightBlocks({ insight, className = '' }) {
  const blocks = useMemo(() => parseInsightBlocks(insight), [insight]);
  if (blocks.length === 0) return null;

  return (
    <div className={`space-y-2 ${className}`}>
      {blocks.map((block, i) => {
        if (block.type === 'header') {
          return (
            <p key={i} className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 pt-1.5 first:pt-0">
              {block.emoji && <span aria-hidden="true" className="text-xs">{block.emoji}</span>}
              {block.text}
            </p>
          );
        }
        if (block.type === 'bullet') {
          return (
            <div key={i} className="flex gap-2 pl-0.5">
              <span aria-hidden="true" className="text-violet-400 leading-5 shrink-0">·</span>
              <p className="text-[11.5px] leading-5 text-slate-600 dark:text-slate-300">{renderInline(block.text)}</p>
            </div>
          );
        }
        return (
          <p key={i} className="text-[11.5px] leading-5 text-slate-600 dark:text-slate-300">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
