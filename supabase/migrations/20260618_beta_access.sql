-- Private beta access control
-- Trazza is in private beta: signups are open but app access requires admin
-- approval, unless the email (or its domain) is on the allowlist.
--
-- Flow:
--   1. A user signs up (email/password or Google OAuth).
--   2. The AFTER INSERT trigger on auth.users creates a beta_access row,
--      auto-approved if the email/domain is allowlisted, else 'pending'.
--   3. The frontend gates /app on beta_access.status = 'approved'.
--   4. An admin approves/rejects from the Admin Dashboard (server, service role),
--      which emails the user.

-- ── beta_access: one row per user ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS beta_access (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz DEFAULT now(),
  decided_at   timestamptz,
  decided_by   uuid
);

CREATE INDEX IF NOT EXISTS beta_access_status_idx ON beta_access (status);
CREATE INDEX IF NOT EXISTS beta_access_email_idx  ON beta_access (lower(email));

-- ── beta_allowlist: emails or domains that auto-approve on signup ──────────────
CREATE TABLE IF NOT EXISTS beta_allowlist (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  value      text NOT NULL,                                   -- stored lowercase
  type       text NOT NULL CHECK (type IN ('email', 'domain')),
  added_by   uuid,
  created_at timestamptz DEFAULT now(),
  UNIQUE (type, value)
);

-- ── RLS ────────────────────────────────────────────────────────────────────────
-- beta_access: each user can read ONLY their own status. Writes happen via the
-- SECURITY DEFINER trigger and the server (service role bypasses RLS).
ALTER TABLE beta_access ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'beta_access' AND policyname = 'users read own beta_access'
  ) THEN
    CREATE POLICY "users read own beta_access"
      ON beta_access FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- beta_allowlist: no client access at all — only the server (service role).
ALTER TABLE beta_allowlist ENABLE ROW LEVEL SECURITY;

-- ── Trigger: create beta_access on signup, applying the allowlist ──────────────
CREATE OR REPLACE FUNCTION handle_new_user_beta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw_email text := nullif(to_jsonb(NEW)->>'email', '');
  v_email     text := lower(v_raw_email);
  v_domain    text := split_part(v_email, '@', 2);
  v_allowed boolean;
BEGIN
  IF v_raw_email IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM beta_allowlist
    WHERE (type = 'email'  AND value = v_email)
       OR (type = 'domain' AND value = v_domain)
  ) INTO v_allowed;

  INSERT INTO beta_access (user_id, email, status, decided_at)
  VALUES (
    NEW.id,
    v_raw_email,
    CASE WHEN v_allowed THEN 'approved' ELSE 'pending' END,
    CASE WHEN v_allowed THEN now()      ELSE NULL END
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_beta ON auth.users;
CREATE TRIGGER on_auth_user_created_beta
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user_beta();

-- ── Backfill: grandfather every existing user as approved ─────────────────────
-- Prevents locking out current users (including the admin) when gating goes live.
INSERT INTO beta_access (user_id, email, status, decided_at)
SELECT u.id, (to_jsonb(u)->>'email'), 'approved', now()
FROM auth.users u
WHERE (to_jsonb(u)->>'email') IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;
