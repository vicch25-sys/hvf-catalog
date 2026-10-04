BEGIN;
CREATE TABLE IF NOT EXISTS public.catalog_stock (
  machine_id text PRIMARY KEY,
  quantity integer NOT NULL CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL
);
ALTER TABLE public.catalog_stock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalog_stock FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_catalog_stock()
RETURNS TABLE(machine_id text, quantity integer, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor_admin boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)) THEN
    RAISE EXCEPTION 'Catalog management permission required';
  END IF;
  SELECT p.is_admin INTO actor_admin FROM public.profiles p WHERE p.user_id = auth.uid();
  RETURN QUERY SELECT s.machine_id, s.quantity, s.updated_at FROM public.catalog_stock s
    JOIN public.machines m ON m.id::text = s.machine_id
    WHERE actor_admin IS TRUE OR m.is_hidden IS FALSE;
END; $$;

CREATE OR REPLACE FUNCTION public.save_catalog_stock(changes jsonb)
RETURNS TABLE(machine_id text, quantity integer, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor_admin boolean;
  entry jsonb;
  current_row public.catalog_stock%ROWTYPE;
  target_id text;
  expected_time timestamptz;
  next_quantity integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)) THEN
    RAISE EXCEPTION 'Catalog management permission required';
  END IF;
  SELECT p.is_admin INTO actor_admin FROM public.profiles p WHERE p.user_id = auth.uid();
  IF jsonb_typeof(changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid stock changes'; END IF;
  IF jsonb_array_length(changes) > 5000 THEN RAISE EXCEPTION 'Too many stock changes'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(changes) e GROUP BY e->>'machine_id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate product in stock changes';
  END IF;
  -- Stable lock ordering prevents competing bulk saves from deadlocking.
  FOR entry IN SELECT value FROM jsonb_array_elements(changes) ORDER BY value->>'machine_id' LOOP
    target_id := entry->>'machine_id';
    IF target_id IS NULL OR COALESCE(entry->>'quantity', '') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Enter a nonnegative whole quantity'; END IF;
    next_quantity := (entry->>'quantity')::integer;
    expected_time := (entry->>'expected_updated_at')::timestamptz;
    PERFORM 1 FROM public.machines m WHERE m.id::text = target_id AND (actor_admin IS TRUE OR m.is_hidden IS FALSE) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product is unavailable or not permitted'; END IF;
    SELECT * INTO current_row FROM public.catalog_stock s WHERE s.machine_id = target_id FOR UPDATE;
    IF current_row.updated_at IS DISTINCT FROM expected_time THEN
      RAISE EXCEPTION 'Stock changed on another device. Close and reopen the editor to review the latest quantity.';
    END IF;
    IF current_row.quantity IS NOT DISTINCT FROM next_quantity THEN CONTINUE; END IF;
    INSERT INTO public.catalog_stock AS existing (machine_id, quantity, updated_at, updated_by)
      VALUES (target_id, next_quantity, clock_timestamp(), auth.uid())
      ON CONFLICT ON CONSTRAINT catalog_stock_pkey DO UPDATE
      SET quantity = EXCLUDED.quantity, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  END LOOP;
  RETURN QUERY SELECT s.machine_id, s.quantity, s.updated_at FROM public.catalog_stock s
    WHERE s.machine_id IN (SELECT e->>'machine_id' FROM jsonb_array_elements(changes) e);
END; $$;
REVOKE ALL ON FUNCTION public.get_catalog_stock() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_catalog_stock(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_catalog_stock() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_catalog_stock(jsonb) TO authenticated;
COMMIT;
