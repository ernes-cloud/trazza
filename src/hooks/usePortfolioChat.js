import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { aiHttpErrorMessage } from '@/lib/aiHttpErrorMessage';

const CHAT_ENDPOINT = '/api/portfolio-chat';
const MAX_HISTORY   = 16; // max messages kept in state (8 turns)

async function getAuthHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
  };
}

export function usePortfolioChat() {
  const { t } = useTranslation();
  const [messages, setMessages]   = useState([]);
  const [sending, setSending]     = useState(false);
  const [error, setError]         = useState(null);
  // 'daily' | 'monthly' | null — set when server returns 429
  const [limitReason, setLimitReason] = useState(null);

  const sendMessage = useCallback(async (text, context) => {
    if (!text?.trim() || sending) return;

    const userMsg = { role: 'user', content: text.trim() };
    const nextMessages = [...messages, userMsg].slice(-MAX_HISTORY);

    setMessages(nextMessages);
    setSending(true);
    setError(null);
    setLimitReason(null);

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: nextMessages, context }),
        signal: AbortSignal.timeout(25_000),
      });

      if (res.status === 429) {
        const data = await res.json();
        setLimitReason(data.reason || 'daily');
        setMessages(prev => prev.filter(m => m !== userMsg));
        return;
      }

      if (res.status === 401) {
        const isDemo = localStorage.getItem('trazza_demo_mode') === 'true';
        setError(isDemo ? t('cartera.ai_chat_demo') : t('cartera.ai_chat_session_expired'));
        setMessages(prev => prev.filter(m => m !== userMsg));
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(aiHttpErrorMessage({
          status: res.status, error: body.error, code: body.code, t,
        }));
        setMessages(prev => prev.filter(m => m !== userMsg));
        return;
      }

      const data = await res.json();
      const reply = data.reply || 'Sin respuesta.';

      setMessages(prev => [...prev, { role: 'assistant', content: reply }].slice(-MAX_HISTORY));
    } catch (err) {
      const msg = err.name === 'TimeoutError'
        ? t('cartera.ai_timeout')
        : t('cartera.ai_chat_connect_failed');
      setError(msg);
      setMessages(prev => prev.filter(m => m !== userMsg));
    } finally {
      setSending(false);
    }
  }, [messages, sending, t]);

  const clearChat = useCallback(() => {
    setMessages([]);
    setError(null);
    setLimitReason(null);
  }, []);

  return { messages, sending, error, limitReason, sendMessage, clearChat };
}
