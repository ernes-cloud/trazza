-- Webhook de correo al insertar en `notifications`: URL y secreto en Supabase Vault.
-- Sin vault/pg_net o sin secretos configurados → NO-OP (nunca RAISE).
-- Idempotente: stub por defecto; función completa cuando vault + pg_net existen.

CREATE OR REPLACE FUNCTION public.trigger_notification_email_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $noop$
BEGIN
  RETURN NEW;
END;
$noop$;

REVOKE ALL ON FUNCTION public.trigger_notification_email_webhook() FROM PUBLIC, anon, authenticated;

DO $install$
DECLARE
  v_has_vault boolean;
  v_has_net boolean;
BEGIN
  v_has_vault := to_regnamespace('vault') IS NOT NULL
    AND to_regclass('vault.decrypted_secrets') IS NOT NULL;
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') INTO v_has_net;

  IF NOT v_has_vault OR NOT v_has_net THEN
    RETURN;
  END IF;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.trigger_notification_email_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $body$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  IF NEW.send_email IS FALSE THEN
    RETURN NEW;
  END IF;

  SELECT s.decrypted_secret INTO v_url
    FROM vault.decrypted_secrets AS s
   WHERE s.name = 'notify_webhook_url'
   LIMIT 1;

  SELECT s.decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets AS s
   WHERE s.name = 'notify_webhook_secret'
   LIMIT 1;

  IF v_url IS NULL OR btrim(v_url) = '' OR v_secret IS NULL OR btrim(v_secret) = '' THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', v_secret
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', jsonb_build_object(
        'id', NEW.id,
        'user_id', NEW.user_id,
        'title', NEW.title,
        'message', NEW.message,
        'is_read', NEW.is_read,
        'created_at', NEW.created_at,
        'link', NEW.link,
        'type', NEW.type,
        'send_email', NEW.send_email
      )
    )
  );

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NEW;
END;
$body$;
$fn$;

  EXECUTE $revoke$
REVOKE ALL ON FUNCTION public.trigger_notification_email_webhook() FROM PUBLIC, anon, authenticated;
$revoke$;
END;
$install$;

-- Idempotent: stub or vault-backed body — never rely on default EXECUTE for PUBLIC/roles.
REVOKE ALL ON FUNCTION public.trigger_notification_email_webhook() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS email_notifications ON public.notifications;
DROP TRIGGER IF EXISTS notify_email_on_insert ON public.notifications;

CREATE TRIGGER email_notifications
  AFTER INSERT ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_notification_email_webhook();
