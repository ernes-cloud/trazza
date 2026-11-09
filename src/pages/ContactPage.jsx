import { useState } from 'react';
import { Link } from 'react-router-dom';
import SeoHead from '@/components/SeoHead';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { motionInitial } from '@/lib/prerenderBoot';
import { TrendingUp, CheckCircle, Send, Loader2 } from 'lucide-react';
import { getContactEmail } from '@/lib/appContact';

const ContactPage = () => {
  const { t, i18n } = useTranslation();
  const [form, setForm] = useState({ name: '', email: '', message: '' });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleChange = (e) => setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSending(true);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error('Server error');
      setSent(true);
    } catch {
      // Show error state — keep form visible so user can retry
      alert(t('common.error'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#faf9f7', color: '#0f172a' }}>
      <SeoHead path="/contact" title={t('contact.page_title')} description={t('contact.meta_description')} lang={i18n.language} />

      <header
        className="fixed top-0 w-full z-50 border-b"
        style={{ backgroundColor: 'rgba(250,249,247,0.92)', backdropFilter: 'blur(14px)', borderColor: 'rgba(15,23,42,0.12)' }}
      >
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="bg-blue-600 p-1.5 rounded-lg">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-bold text-slate-900 tracking-tight">Trazza</span>
          </Link>
          <Link to="/" className="text-sm text-slate-500 hover:text-slate-900 transition-colors">
            {t('contact.back')}
          </Link>
        </div>
      </header>

      <main className="pt-28 pb-20 px-6 flex items-start justify-center">
        <motion.div
          initial={motionInitial({ opacity: 0, y: 20 })}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full max-w-lg"
        >
          {sent ? (
            <div className="text-center py-16">
              <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5" style={{ backgroundColor: 'rgba(5,150,105,0.10)' }}>
                <CheckCircle className="w-8 h-8 text-emerald-600" />
              </div>
              <h2 className="text-2xl font-black text-slate-900 mb-2">{t('contact.sent_title')}</h2>
              <p className="text-slate-500 text-sm mb-8">{t('contact.sent_desc')}</p>
              <Link to="/">
                <button className="text-sm text-blue-600 hover:text-blue-700 transition-colors">
                  {t('contact.back')}
                </button>
              </Link>
            </div>
          ) : (
            <>
              <h1 className="text-3xl font-black text-slate-900 mb-2">{t('contact.title')}</h1>
              <p className="text-slate-500 text-sm mb-8">{t('contact.subtitle')}</p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-xs text-slate-500 font-medium block mb-1.5">{t('contact.name_label')}</label>
                  <input
                    type="text"
                    name="name"
                    required
                    value={form.name}
                    onChange={handleChange}
                    placeholder={t('contact.name_placeholder')}
                    className="w-full rounded-xl px-4 py-3 text-sm text-slate-900 placeholder-slate-400 border outline-hidden focus:ring-2 focus:ring-blue-500/40 transition-all"
                    style={{ backgroundColor: '#ffffff', borderColor: 'rgba(15,23,42,0.14)' }}
                  />
                </div>

                <div>
                  <label className="text-xs text-slate-500 font-medium block mb-1.5">{t('contact.email_label')}</label>
                  <input
                    type="email"
                    name="email"
                    required
                    value={form.email}
                    onChange={handleChange}
                    placeholder={t('contact.email_placeholder')}
                    className="w-full rounded-xl px-4 py-3 text-sm text-slate-900 placeholder-slate-400 border outline-hidden focus:ring-2 focus:ring-blue-500/40 transition-all"
                    style={{ backgroundColor: '#ffffff', borderColor: 'rgba(15,23,42,0.14)' }}
                  />
                </div>

                <div>
                  <label className="text-xs text-slate-500 font-medium block mb-1.5">{t('contact.message_label')}</label>
                  <textarea
                    name="message"
                    required
                    rows={6}
                    value={form.message}
                    onChange={handleChange}
                    placeholder={t('contact.message_placeholder')}
                    className="w-full rounded-xl px-4 py-3 text-sm text-slate-900 placeholder-slate-400 border outline-hidden focus:ring-2 focus:ring-blue-500/40 transition-all resize-none"
                    style={{ backgroundColor: '#ffffff', borderColor: 'rgba(15,23,42,0.14)' }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={sending}
                  className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors text-white font-bold py-3.5 rounded-xl text-sm"
                >
                  {sending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t('contact.sending')}
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      {t('contact.submit')}
                    </>
                  )}
                </button>
              </form>

              <p className="text-xs text-slate-500 text-center mt-6">
                {t('contact.also_email')}{' '}
                <a href={`mailto:${getContactEmail()}`} className="text-blue-600 hover:underline">
                  {getContactEmail()}
                </a>
              </p>
            </>
          )}
        </motion.div>
      </main>
    </div>
  );
};

export default ContactPage;
