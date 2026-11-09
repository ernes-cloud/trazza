/**
 * Correo de activación: a quien se registró hace 24–72 h y aún no ha metido
 * ninguna operación, UNO con los pasos para exportar el fichero de su broker.
 *
 * Corre cada hora. Quién lo recibe lo decide lib/activationEmail.js (puro).
 * La marca de "ya enviado" va en `app_metadata.activation_email_at` de la
 * cuenta (solo la escribe el service role), no en `email_sends`: así la
 * deduplicación no depende de una migración ni de un registro fire-and-forget.
 * Si la marca falla, el set en memoria evita repetir mientras el proceso viva.
 */

import { supabaseAdmin } from '../lib/adminSupabase.js';
import { sendEmail } from '../lib/emailTransport.js';
import { addLog } from '../lib/logBuffer.js';
import { listAllAuthUsers } from '../lib/authUsers.js';
import { selectActivationCandidates, buildActivationEmail, pickGuides } from '../lib/activationEmail.js';
import { getContactEmail } from '../lib/appContact.js';

const RUN_EVERY_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 4 * 60 * 1000;   // detrás del resto de crons
const MAX_PER_RUN = 25;                   // tope de seguridad: un fallo de lógica no puede escribir a todo el mundo

const REPLY_TO = getContactEmail();

const sentThisProcess = new Set();
let running = false;

export async function runActivationEmails({ now = new Date() } = {}) {
  if (running || !supabaseAdmin) return null;
  running = true;
  try {
    const [{ data: funnelRows, error: funnelErr }, authUsers] = await Promise.all([
      supabaseAdmin.rpc('admin_user_funnel'),
      listAllAuthUsers(supabaseAdmin),
    ]);
    if (funnelErr) throw new Error(`admin_user_funnel: ${funnelErr.message}`);

    // Preferencias solo de las cuentas recientes (las únicas que pueden tocar).
    const recentIds = authUsers
      .filter((u) => now.getTime() - new Date(u.created_at).getTime() < 4 * 24 * 60 * 60 * 1000)
      .map((u) => u.id);
    const prefsByUser = new Map();
    if (recentIds.length) {
      const { data: prefs, error: prefsErr } = await supabaseAdmin
        .from('user_preferences').select('*').in('user_id', recentIds);
      // Sin preferencias no se puede saber si alguien apagó los correos: no se envía nada.
      if (prefsErr) throw new Error(`user_preferences: ${prefsErr.message}`);
      for (const p of prefs || []) prefsByUser.set(p.user_id, p);
    }

    const excludeIds = (process.env.FUNNEL_EXCLUDE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const candidates = selectActivationCandidates({
      authUsers, funnelRows: funnelRows || [], prefsByUser, now, excludeIds, alreadySent: sentThisProcess,
    }).slice(0, MAX_PER_RUN);

    const summary = { candidates: candidates.length, sent: 0, failed: 0 };
    if (!candidates.length) return summary;

    const { data: brokers } = await supabaseAdmin
      .from('brokers').select('user_id, name').in('user_id', candidates.map((c) => c.userId));
    const brokerNames = new Map();
    for (const b of brokers || []) {
      if (!brokerNames.has(b.user_id)) brokerNames.set(b.user_id, []);
      brokerNames.get(b.user_id).push(b.name);
    }

    const byId = new Map(authUsers.map((u) => [u.id, u]));
    for (const c of candidates) {
      const { subject, html, text } = buildActivationEmail({ lang: c.lang, guides: pickGuides(brokerNames.get(c.userId) || []) });
      const result = await sendEmail({ kind: 'activation', userId: c.userId, to: c.email, subject, html, text, replyTo: REPLY_TO });
      if (!result.ok) { summary.failed++; continue; }
      summary.sent++;
      sentThisProcess.add(c.userId);
      const { error: markErr } = await supabaseAdmin.auth.admin.updateUserById(c.userId, {
        app_metadata: { ...(byId.get(c.userId)?.app_metadata || {}), activation_email_at: now.toISOString() },
      });
      if (markErr) addLog('warn', 'email', `Activación: no se pudo marcar el envío (${markErr.message})`);
    }

    console.log('[activationEmail]', JSON.stringify(summary));
    addLog(summary.failed ? 'warn' : 'info', 'email', `Correo de activación: ${summary.sent} enviados, ${summary.failed} fallidos`);
    return summary;
  } finally {
    running = false;
  }
}

export function startActivationEmailCron() {
  if (!supabaseAdmin) {
    console.warn('[activationEmail] Supabase admin client not configured — cron disabled.');
    return;
  }
  const run = () => runActivationEmails().catch((e) => {
    console.error('[activationEmail] run error:', e.message);
    addLog('error', 'email', `Correo de activación: ${e.message}`);
  });
  setTimeout(run, STARTUP_DELAY_MS);
  setInterval(run, RUN_EVERY_MS);
  console.log('[activationEmail] Cron scheduled (hourly).');
}
