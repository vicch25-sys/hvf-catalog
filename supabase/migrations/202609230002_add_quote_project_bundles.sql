CREATE TABLE IF NOT EXISTS public.quote_project_bundles (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.quote_project_bundles ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.quote_project_bundles TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.quote_project_bundles TO authenticated;

DROP POLICY IF EXISTS "Project bundles are readable by everyone"
  ON public.quote_project_bundles;
CREATE POLICY "Project bundles are readable by everyone"
  ON public.quote_project_bundles
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Admins can insert project bundles"
  ON public.quote_project_bundles;
CREATE POLICY "Admins can insert project bundles"
  ON public.quote_project_bundles
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

DROP POLICY IF EXISTS "Admins can update project bundles"
  ON public.quote_project_bundles;
CREATE POLICY "Admins can update project bundles"
  ON public.quote_project_bundles
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

DROP POLICY IF EXISTS "Admins can delete project bundles"
  ON public.quote_project_bundles;
CREATE POLICY "Admins can delete project bundles"
  ON public.quote_project_bundles
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND profile.is_admin IS TRUE
    )
  );
