BEGIN;

CREATE TABLE IF NOT EXISTS public.catalog_stock_check_status (
  include_hidden boolean PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checked_by uuid NOT NULL
);
ALTER TABLE public.catalog_stock_check_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_stock_check_status FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.get_catalog_stock();
CREATE FUNCTION public.get_catalog_stock()
RETURNS TABLE(machine_id text, quantity integer, updated_at timestamptz, checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor_admin boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ) THEN
    RAISE EXCEPTION 'Catalog management permission required';
  END IF;
  SELECT p.is_admin INTO actor_admin
  FROM public.profiles p WHERE p.user_id = auth.uid();

  RETURN QUERY
  SELECT m.id::text, s.quantity, s.updated_at,
    CASE WHEN m.is_hidden IS TRUE THEN all_check.checked_at
         ELSE GREATEST(all_check.checked_at, visible_check.checked_at)
    END
  FROM public.machines m
  LEFT JOIN public.catalog_stock s ON s.machine_id = m.id::text
  LEFT JOIN public.catalog_stock_check_status all_check ON all_check.include_hidden IS TRUE
  LEFT JOIN public.catalog_stock_check_status visible_check ON visible_check.include_hidden IS FALSE
  WHERE actor_admin IS TRUE OR m.is_hidden IS FALSE;
END; $$;

CREATE OR REPLACE FUNCTION public.confirm_catalog_stock_check(include_hidden boolean DEFAULT false)
RETURNS TABLE(checked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor_admin boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ) THEN
    RAISE EXCEPTION 'Catalog management permission required';
  END IF;
  SELECT p.is_admin INTO actor_admin
  FROM public.profiles p WHERE p.user_id = auth.uid();
  IF include_hidden IS TRUE AND actor_admin IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Only an admin may confirm hidden inventory';
  END IF;

  RETURN QUERY
  INSERT INTO public.catalog_stock_check_status AS existing (include_hidden, checked_at, checked_by)
  VALUES (include_hidden, clock_timestamp(), auth.uid())
  ON CONFLICT (include_hidden) DO UPDATE
    SET checked_at = EXCLUDED.checked_at, checked_by = EXCLUDED.checked_by
  RETURNING existing.checked_at;
END; $$;

REVOKE ALL ON FUNCTION public.get_catalog_stock() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_catalog_stock_check(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_catalog_stock() TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_catalog_stock_check(boolean) TO authenticated;

COMMIT;
