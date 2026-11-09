import { supabaseAdmin } from '../lib/adminSupabase.js';
import { sendEmail }     from '../lib/emailTransport.js';
import { addLog }        from '../lib/logBuffer.js';
import { buildNotificationEmail } from '../lib/notificationEmail.js';
import { getEmailFrom } from '../lib/appContact.js';
import { createHash, timingSafeEqual } from 'node:crypto';

export async function emailNotify(req, res) {
  // Verify webhook secret
  const secret = req.headers['x-webhook-secret'];
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (!expectedSecret || typeof secret !== 'string') {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }
  const providedBuffer = createHash('sha256').update(secret, 'utf8').digest();
  const expectedBuffer = createHash('sha256').update(expectedSecret, 'utf8').digest();
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  // Supabase sends: { type, table, record, old_record, schema }
  const { type, record } = req.body || {};
  if (type !== 'INSERT' || !record) {
    return res.status(200).json({ skipped: 'not an INSERT event' });
  }

  const { user_id, title, message, type: notifType, link } = record;

  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id in record' });
  }

  // El cron marca send_email=false cuando la alerta que la origina tiene el
  // correo apagado en Favoritos: la notificación existe en la app, pero no se
  // empuja al buzón. Solo `false` explícito corta (filas antiguas = null).
  if (record.send_email === false) {
    return res.status(200).json({ skipped: 'email disabled for this notification' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase admin client not configured' });
  }

  try {
    // 1. Get user email from Auth
    const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(user_id);
    if (userErr || !userData?.user?.email) {
      console.warn('[emailNotify] Could not fetch user email:', userErr?.message);
      return res.status(200).json({ skipped: 'user email not found' });
    }
    const email = userData.user.email;

    // 2. Check user preference. select('*'): una columna nombrada que aún no
    //    exista tumbaría la consulta entera (ver CLAUDE.md). Si no se puede
    //    leer, se manda igual (perder un aviso es peor), en español.
    const { data: prefs, error: prefsErr } = await supabaseAdmin
      .from('user_preferences')
      .select('*')
      .eq('user_id', user_id)
      .maybeSingle();
    if (prefsErr) console.warn('[emailNotify] Could not read preferences:', prefsErr.message);

    if (prefs?.email_notifications_enabled === false) {
      return res.status(200).json({ skipped: 'email notifications disabled by user' });
    }

    // 3. Build and send email — plantilla corta con UN botón al enlace de la
    //    notificación (lib/notificationEmail.js, pura y testeada). Antes era un
    //    bloque genérico que no usaba `link`: un artículo del blog llegaba sin
    //    forma de abrirlo y con dos emojis en el asunto.
    const from = getEmailFrom();
    const mail = buildNotificationEmail({ title, message, type: notifType, link, lang: prefs?.language });

    const result = await sendEmail({
      kind:    'notification',
      userId:  user_id,
      reportPeriodKey: record.id,
      from,
      to:      email,
      subject: mail.subject,
      text:    mail.text,
      html:    mail.html,
    });

    // Se responde 200 también cuando falla, para que Supabase no reintente el
    // webhook: los reintentos los hace ya `sendEmail` con criterio (4xx y red
    // sí, 5xx y credenciales no). La diferencia con antes es que el fallo YA
    // NO desaparece en silencio: queda en logs con su error y
    // su número de intentos, que es lo que permite enterarse de que algo no se
    // está entregando.
    // El tope diario NO es una avería: la notificación existe y el usuario la
    // ve en la app, solo no se le empuja al buzón. Se separa del camino de
    // error para que no cuente como fallo de entrega en ningún log ni alerta.
    if (result.capped) {
      addLog('warn', 'email', `Tope diario alcanzado → ${email}, no se envía`, { title });
      return res.status(200).json({ sent: false, capped: true });
    }

    if (result.duplicate) {
      return res.status(200).json({ sent: false, duplicate: true });
    }

    if (!result.ok) {
      console.error('[emailNotify] Failed to send email:', result.error);
      addLog('error', 'email', `Notification failed after ${result.attempts} attempt(s): ${result.error}`, { email });
      return res.status(200).json({ sent: false, error: result.error });
    }

    console.log(`[emailNotify] Sent to ${email}: "${title}"`);
    addLog('ok', 'email', `Notification sent → ${email}`, { title, type: notifType });
    return res.status(200).json({ sent: true });

  } catch (err) {
    // Aquí ya solo caen fallos AJENOS al envío (Supabase Auth, preferencias).
    console.error('[emailNotify] Unexpected error:', err.message);
    addLog('error', 'email', `Notification handler error: ${err.message}`, { user_id });
    return res.status(200).json({ error: err.message });
  }
}
