import React, { useMemo } from 'react';
import { parseChatMarkdown } from '@/lib/chatMarkdown';
import { renderInline } from '@/components/ui/AiInsightBlocks';

/**
 * Respuesta del chat de cartera, pintada para un panel ESTRECHO (~360 px).
 * Las tablas no caben: cada fila se convierte en una tarjeta con la primera
 * columna como título y el resto como pares etiqueta → valor.
 */
function TableAsCards({ headers, rows }) {
  return (
    <div className="space-y-1.5">
      {rows.map((cells, r) => (
        <div key={r} className="rounded-xl bg-white/70 dark:bg-slate-900/50 border border-slate-200/70 dark:border-slate-700/60 px-2.5 py-1.5">
          <p className="text-[12.5px] font-semibold text-slate-800 dark:text-slate-100 leading-snug">{renderInline(cells[0])}</p>
          {cells.length > 1 && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] leading-snug">
              {cells.slice(1).map((cell, c) => (cell ? (
                <React.Fragment key={c}>
                  <dt className="text-slate-500 dark:text-slate-400">{headers[c + 1] || ''}</dt>
                  <dd className="text-right tabular-nums text-slate-700 dark:text-slate-200">{renderInline(cell)}</dd>
                </React.Fragment>
              ) : null))}
            </dl>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ChatMarkdown({ text }) {
  const blocks = useMemo(() => parseChatMarkdown(text), [text]);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          return <p key={i} className="text-[12.5px] font-bold text-slate-800 dark:text-slate-100">{renderInline(b.text)}</p>;
        }
        if (b.type === 'table') return <TableAsCards key={i} headers={b.headers} rows={b.rows} />;
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={i} className={`${b.ordered ? 'list-decimal' : 'list-disc'} pl-4 space-y-1 marker:text-slate-400`}>
              {b.items.map((it, j) => (
                <li key={j}>
                  {renderInline(it.text)}
                  {it.children.length > 0 && (
                    <ul className="list-[circle] pl-4 mt-0.5 space-y-0.5 marker:text-slate-400">
                      {it.children.map((c, k) => <li key={k}>{renderInline(c)}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </Tag>
          );
        }
        return <p key={i} className="whitespace-pre-line">{renderInline(b.text)}</p>;
      })}
    </div>
  );
}
