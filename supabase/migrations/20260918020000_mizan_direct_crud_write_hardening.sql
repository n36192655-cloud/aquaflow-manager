-- MIZAN direct CRUD write hardening.
-- Customer/meter onboarding is intentionally exposed through validated SECURITY DEFINER RPCs.
-- Prevent authenticated clients from bypassing those validations with direct table writes.
-- RLS remains enabled; SELECT stays available to the existing tenant policies.

REVOKE INSERT, UPDATE, DELETE ON public.customers FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.meter_profiles FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.meters FROM authenticated;
