import React, { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Loader2, Bot, User, Sparkles, Trash2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePortfolioChat } from '@/hooks/usePortfolioChat';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import { useAiUsage } from '@/hooks/useAiUsage';
import { usePortfolioData } from '@/contexts/PortfolioDataContext';
import { buildPortfolioContext } from '@/services/portfolioContextService';
import { peekPerformanceSeries } from '@/hooks/usePortfolioPerformance';
import ChatMarkdown from '@/components/chat/ChatMarkdown';


function ChatBubble({ msg }) {
  const isUser = msg.role === 'user';
  // El asistente responde en markdown (listas, negritas, a veces tablas): se
  // pinta con ChatMarkdown. Antes salía como texto plano con los ** y las
  // tablas en crudo, ilegibles en un panel de 360 px.
  return (
    <div className={`flex items-end gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
        isUser ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-700'
      }`}>
        {isUser
          ? <User className="w-3.5 h-3.5 text-white" />
          : <Bot className="w-3.5 h-3.5 text-slate-500 dark:text-slate-300" />
        }
      </div>
      <div className={`min-w-0 px-3 py-2 rounded-2xl text-[13px] leading-relaxed ${
        isUser
          ? 'max-w-[78%] whitespace-pre-wrap bg-blue-600 text-white rounded-br-sm'
          : 'max-w-[88%] bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 rounded-bl-sm'
      }`}>
        {isUser ? msg.content : <ChatMarkdown text={msg.content} />}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-end gap-2">
      <div className="shrink-0 w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
        <Bot className="w-3.5 h-3.5 text-slate-500 dark:text-slate-300" />
      </div>
      <div className="bg-slate-100 dark:bg-slate-800 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1 items-center">
        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
      </div>
    </div>
  );
}

export default function PortfolioChatWidget() {
  const { user } = useSupabaseAuth();
  const { t } = useTranslation();
  const [open, setOpen]   = useState(false);
  const [input, setInput] = useState('');
  const bottomRef         = useRef(null);
  const inputRef          = useRef(null);

  const SUGGESTIONS = [
    t('chat.suggestion_1'),
    t('chat.suggestion_2'),
    t('chat.suggestion_3'),
    t('chat.suggestion_4'),
  ];

  const { messages, sending, error, limitReason, sendMessage, clearChat } = usePortfolioChat();
  const { dailyLeft, monthlyLeft, exhausted: chatExhausted, refresh: refreshChatUsage } = useAiUsage('chat');
  const { portfolioSnapshot } = usePortfolioData();

  // Build context from the Dashboard's already-computed snapshot (same values shown in UI)
  const context = portfolioSnapshot
    ? buildPortfolioContext({
        positions:  portfolioSnapshot.positions,
        brokers:    portfolioSnapshot.brokers,
        summary: {
          totalWealth:    portfolioSnapshot.totalWealth,
          totalInvested:  portfolioSnapshot.totalInvested,
          cashPosition:   portfolioSnapshot.cashPosition,
          totalGainAbs:   portfolioSnapshot.totalGainAbs,
          totalGainPct:   portfolioSnapshot.totalGainPct,
          dailyChangePct: portfolioSnapshot.dailyChangePct,
          totalDividends: portfolioSnapshot.totalDividends,
          totalFees:      portfolioSnapshot.totalFees,
          realizedGain:   portfolioSnapshot.realizedGain,
        },
        rates:    portfolioSnapshot.exchangeRates,
        currency: portfolioSnapshot.currency,
        // Rentabilidad (TWR total, anualizada, YTD, 1 mes, 1 semana) de la serie
        // que ya calculó el Dashboard — sin descargar nada.
        performanceSeries: user?.id
          ? peekPerformanceSeries({ userId: user.id, brokerId: portfolioSnapshot.scope || 'general', currency: portfolioSnapshot.currency })
          : null,
      })
    : null;

  // Auto-scroll to latest message
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending, open]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    sendMessage(text, context ?? {});
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const isEmpty = messages.length === 0 && !sending && !error;

  return (
    <>
      {/* Floating trigger */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={t('chat.trigger_label')}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-200 ${
          open
            ? 'bg-slate-700 dark:bg-slate-600 rotate-90'
            : 'bg-blue-600 hover:bg-blue-700 active:scale-95'
        }`}
      >
        {open
          ? <X className="w-5 h-5 text-white" />
          : <MessageCircle className="w-6 h-6 text-white" />
        }
        {!open && messages.some(m => m.role === 'assistant') && (
          <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-emerald-400 rounded-full border-2 border-white dark:border-slate-900" />
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-24 right-4 sm:right-6 z-50 w-[380px] max-w-[calc(100vw-2rem)] max-h-[min(600px,calc(100dvh-8rem))] flex flex-col rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">

          {/* Header */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
            <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-bold text-slate-900 dark:text-white leading-none">{t('chat.title')}</p>
              <p className="text-[10px] text-slate-400 mt-0.5">
                {t('chat.subtitle')}
              </p>
            </div>
            {/* Quota badge */}
            <div className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full ${
              chatExhausted
                ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400'
                : dailyLeft <= 3
                ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400'
                : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
            }`}>
              {chatExhausted ? t('ai_usage.exhausted') : t('ai_usage.remaining', { n: dailyLeft })}
            </div>
            <div className="flex items-center gap-1">
              {/* The context comes from the Dashboard snapshot — no manual refresh needed */}
              {messages.length > 0 && (
                <button
                  onClick={clearChat}
                  title={t('chat.clear_title')}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">

            {/* Empty state */}
            {isEmpty && (
              <div className="h-full flex flex-col items-center justify-center text-center gap-4 py-4">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center">
                  <Sparkles className="w-6 h-6 text-blue-500" />
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">{t('chat.empty_title')}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{t('chat.empty_desc')}</p>
                </div>
                <div className="flex flex-col gap-1.5 w-full">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => { setInput(s); setTimeout(() => inputRef.current?.focus(), 50); }}
                      className="w-full text-left text-[12px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 hover:border-blue-300 dark:hover:border-blue-700 transition-all"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <ChatBubble key={i} msg={msg} />
            ))}

            {sending && <TypingIndicator />}

            {error && (
              <div className="text-[12px] text-center text-rose-500 dark:text-rose-400 px-2">
                {error}
              </div>
            )}

            {limitReason && (
              <div className="text-[12px] text-center text-amber-600 dark:text-amber-400 px-2 py-2 bg-amber-50 dark:bg-amber-900/20 rounded-xl">
                {limitReason === 'monthly'
                  ? t('ai_usage.monthly_limit_msg')
                  : t('ai_usage.daily_limit_msg')}
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 pb-3 pt-2 border-t border-slate-100 dark:border-slate-800 shrink-0 bg-white dark:bg-slate-900">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={e => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 72)}px`;
                }}
                onKeyDown={handleKey}
                placeholder={chatExhausted ? t('ai_usage.input_blocked') : t('chat.placeholder')}
                disabled={sending || chatExhausted}
                className="flex-1 resize-none rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-[13px] text-slate-900 dark:text-white placeholder-slate-400 px-3 py-2.5 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all disabled:opacity-50 leading-snug overflow-hidden"
                style={{ minHeight: '40px' }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || sending || chatExhausted}
                className="shrink-0 w-10 h-10 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-95 flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending
                  ? <Loader2 className="w-4 h-4 text-white animate-spin" />
                  : <Send className="w-4 h-4 text-white" />
                }
              </button>
            </div>
            <p className="text-[10px] text-slate-400 mt-1.5 text-center">
              {t('chat.disclaimer')}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
