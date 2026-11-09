-- Explicit per-table GRANTs for ai_usage and corporate_actions.
-- Baseline no longer applies ALTER DEFAULT PRIVILEGES REVOKE; published migrations stay immutable.
-- NO-MERGE: oss-merge never goes back to developSecond.

REVOKE ALL ON TABLE public.corporate_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.corporate_actions TO authenticated;
GRANT ALL ON TABLE public.corporate_actions TO service_role;

REVOKE ALL ON TABLE public.ai_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ai_usage TO authenticated;
GRANT ALL ON TABLE public.ai_usage TO service_role;
