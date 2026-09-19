-- MIZAN: close anonymous execution gaps on meter onboarding RPCs.
-- CREATE OR REPLACE preserves existing ACLs, so explicitly revoke anon as well as PUBLIC.

REVOKE ALL ON FUNCTION public.create_meter_profile(TEXT,TEXT,SMALLINT,SMALLINT,TEXT,JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_meter_profile(TEXT,TEXT,SMALLINT,SMALLINT,TEXT,JSONB)
  TO authenticated;

REVOKE ALL ON FUNCTION public.create_meter(UUID,TEXT,UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_meter(UUID,TEXT,UUID)
  TO authenticated;

REVOKE ALL ON FUNCTION public.deactivate_meter(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deactivate_meter(UUID)
  TO authenticated;
