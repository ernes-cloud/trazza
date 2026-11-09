-- Tercer estado para `email_sends`: 'capped'.
--
-- Un correo que NO se manda porque el usuario ya llegó a su tope diario no
-- es un fallo: es una decisión de política. Meterlo en 'failed' haría mentir
-- a la única métrica para la que existe esta tabla — "¿se están entregando
-- las notificaciones?" —, que empezaría a ponerse roja justo cuando el
-- sistema está haciendo lo correcto.
--
-- Tampoco puede quedarse SIN registrar: sin fila no habría forma de
-- distinguir "hoy no había nada que avisar" de "se bloquearon 40 avisos",
-- que es precisamente el caso en el que hay que ir a mirar qué pasa.

ALTER TABLE public.email_sends
  DROP CONSTRAINT IF EXISTS email_sends_status_check;

ALTER TABLE public.email_sends
  ADD CONSTRAINT email_sends_status_check
  CHECK (status IN ('sent', 'failed', 'capped'));

-- El índice de fallos sigue cubriendo SOLO 'failed' a propósito: un bloqueo
-- por cupo no es una avería y no debe aparecer en esa consulta.
