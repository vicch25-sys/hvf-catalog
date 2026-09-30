CREATE TABLE IF NOT EXISTS public.payroll_shared_state (
  id text PRIMARY KEY DEFAULT 'primary' CHECK (id = 'primary'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payroll_shared_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_shared_state FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.payroll_shared_state TO authenticated;

DROP POLICY IF EXISTS "Admins can read shared payroll state"
  ON public.payroll_shared_state;
CREATE POLICY "Admins can read shared payroll state"
  ON public.payroll_shared_state
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND profile.is_admin IS TRUE
    )
  );

DROP POLICY IF EXISTS "Admins can create shared payroll state"
  ON public.payroll_shared_state;
CREATE POLICY "Admins can create shared payroll state"
  ON public.payroll_shared_state
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND profile.is_admin IS TRUE
    )
  );

DROP POLICY IF EXISTS "Admins can update shared payroll state"
  ON public.payroll_shared_state;
CREATE POLICY "Admins can update shared payroll state"
  ON public.payroll_shared_state
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND profile.is_admin IS TRUE
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND profile.is_admin IS TRUE
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'payroll_shared_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.payroll_shared_state;
  END IF;
END;
$$;
