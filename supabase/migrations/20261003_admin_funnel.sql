-- Embudo de activación + visitas diarias para el panel de admin (2026-10-03).
--
-- Contexto: sin analítica (ni cookies ni terceros, ver sección 8 de la política
-- de privacidad) no había forma de saber dónde se perdía la gente. Un análisis a
-- mano destapó que `last_sign_in_at` engaña — quien vuelve con la sesión
-- guardada no lo actualiza, y 3 usuarios activos parecían abandonados — y que
-- no había ni una alta desde junio. Esto deja esos números a la vista.

-- ── 1. Visitas por día, SOLO recuentos ───────────────────────────────────────
-- Las rellena el job `server/jobs/siteVisits.js` leyendo el log de nginx del
-- propio servidor. Ninguna IP sale del log: aquí solo hay cuántas.
create table if not exists public.site_visits_daily (
  day        date primary key,
  visitors   integer not null check (visitors >= 0),   -- IPs humanas que cargaron la app (JS)
  app_users  integer not null check (app_users >= 0),  -- IPs que llamaron a la API de la app
  updated_at timestamptz not null default now()
);

alter table public.site_visits_daily enable row level security;
-- Sin policies: solo service role (como import_logs o email_sends).

-- ── 2. Embudo por usuario ────────────────────────────────────────────────────
-- SECURITY DEFINER porque lee auth.users y auth.sessions. Devuelve agregados,
-- nunca emails. La actividad sale de las SESIONES (cada refresco del token),
-- no de last_sign_in_at.
-- grant-exempt: service_role
create or replace function public.admin_user_funnel()
returns table (
  user_id         uuid,
  created_at      timestamptz,
  last_activity   timestamptz,
  brokers         integer,
  open_positions  integer,
  transactions    integer,
  beta_status     text,
  plan            text
)
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  has_sessions boolean := to_regclass('auth.sessions') is not null;
begin
  if has_sessions then
    return query
      select
        u.id,
        (to_jsonb(u)->>'created_at')::timestamptz,
        greatest(
          (to_jsonb(u)->>'last_sign_in_at')::timestamptz,
          (select max(greatest(
                    coalesce((to_jsonb(s)->>'refreshed_at')::timestamptz, (to_jsonb(s)->>'created_at')::timestamptz),
                    coalesce((to_jsonb(s)->>'updated_at')::timestamptz,   (to_jsonb(s)->>'created_at')::timestamptz)))
             from auth.sessions s where s.user_id = u.id)
        ),
        (select count(*)::int from public.brokers b where b.user_id = u.id),
        (select count(*)::int
           from public.positions p join public.brokers b on b.id = p.broker_id
          where b.user_id = u.id and p.quantity > 0),
        (select count(*)::int
           from public.transactions t
           join public.positions p on p.id = t.position_id
           join public.brokers b on b.id = p.broker_id
          where b.user_id = u.id),
        (select ba.status from public.beta_access ba where ba.user_id = u.id limit 1),
        (select up.plan from public.user_preferences up where up.user_id = u.id limit 1)
      from auth.users u;
  else
    return query
      select
        u.id,
        (to_jsonb(u)->>'created_at')::timestamptz,
        (to_jsonb(u)->>'last_sign_in_at')::timestamptz,
        (select count(*)::int from public.brokers b where b.user_id = u.id),
        (select count(*)::int
           from public.positions p join public.brokers b on b.id = p.broker_id
          where b.user_id = u.id and p.quantity > 0),
        (select count(*)::int
           from public.transactions t
           join public.positions p on p.id = t.position_id
           join public.brokers b on b.id = p.broker_id
          where b.user_id = u.id),
        (select ba.status from public.beta_access ba where ba.user_id = u.id limit 1),
        (select up.plan from public.user_preferences up where up.user_id = u.id limit 1)
      from auth.users u;
  end if;
end;
$$;

-- Fuera del API REST: solo el server (service role) puede llamarla. Mismo
-- criterio que increment_ai_usage (migración 20260926).
revoke all on function public.admin_user_funnel() from public, anon, authenticated;
grant execute on function public.admin_user_funnel() to service_role;
