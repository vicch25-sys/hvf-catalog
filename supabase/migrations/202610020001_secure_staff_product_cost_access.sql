-- Keep the existing public catalog readable while denying browser roles direct
-- access to purchase costs. Admins and approved catalog staff use guarded RPCs.

CREATE TABLE IF NOT EXISTS public.machine_private_costs (
  machine_id text PRIMARY KEY,
  cost_price numeric
);

ALTER TABLE public.machine_private_costs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.machine_private_costs FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Admins can read private machine costs"
  ON public.machine_private_costs;
CREATE POLICY "Admins can read private machine costs"
  ON public.machine_private_costs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND profile.is_admin IS TRUE
    )
  );

-- Preserve any costs already stored in the legacy catalog column, and preserve
-- any newer values already present in the private table.
INSERT INTO public.machine_private_costs (machine_id, cost_price)
SELECT machine.id::text, machine.cost_price
FROM public.machines AS machine
WHERE machine.cost_price IS NOT NULL
ON CONFLICT (machine_id) DO NOTHING;

-- Price-history snapshots use the protected cost value after migration.
CREATE OR REPLACE FUNCTION public.record_machine_price_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed text[] := ARRAY[]::text[];
  effective_cost numeric;
BEGIN
  IF OLD.mrp IS DISTINCT FROM NEW.mrp THEN
    changed := array_append(changed, 'mrp');
  END IF;
  IF OLD.sell_price IS DISTINCT FROM NEW.sell_price THEN
    changed := array_append(changed, 'sell_price');
  END IF;

  IF cardinality(changed) > 0 THEN
    SELECT private_cost.cost_price INTO effective_cost
    FROM public.machine_private_costs AS private_cost
    WHERE private_cost.machine_id = NEW.id::text;

    NEW.price_updated_at := now();
    NEW.price_change_count := COALESCE(OLD.price_change_count, 0) + 1;

    INSERT INTO public.machine_price_history (
      machine_id, product_name, changed_at, old_prices, new_prices,
      changed_fields, previous_values_known
    ) VALUES (
      NEW.id::text, NEW.name, NEW.price_updated_at,
      jsonb_build_object('mrp', OLD.mrp, 'sell_price', OLD.sell_price, 'cost_price', effective_cost),
      jsonb_build_object('mrp', NEW.mrp, 'sell_price', NEW.sell_price, 'cost_price', effective_cost),
      changed, true
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS machines_record_price_change ON public.machines;
CREATE TRIGGER machines_record_price_change
  BEFORE UPDATE OF mrp, sell_price
  ON public.machines
  FOR EACH ROW
  EXECUTE FUNCTION public.record_machine_price_change();

-- Remove inherited/table-wide SELECT grants, then restore access to every
-- catalog column except cost_price for the normal public catalog experience.
REVOKE SELECT ON TABLE public.machines FROM PUBLIC, anon, authenticated;
DO $$
DECLARE
  readable_columns text;
BEGIN
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
  INTO readable_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'machines'
    AND column_name <> 'cost_price';

  IF readable_columns IS NULL THEN
    RAISE EXCEPTION 'No readable catalog columns found on public.machines';
  END IF;

  EXECUTE format(
    'GRANT SELECT (%s) ON TABLE public.machines TO anon, authenticated',
    readable_columns
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_catalog_machine_costs()
RETURNS TABLE (machine_id text, cost_price numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_is_admin boolean;
BEGIN
  SELECT COALESCE(profile.is_admin, false) INTO actor_is_admin
  FROM public.profiles AS profile
  WHERE profile.user_id = auth.uid();

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles AS profile
    WHERE profile.user_id = auth.uid()
      AND (profile.is_admin IS TRUE OR profile.can_manage_catalog IS TRUE)
  ) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT private_cost.machine_id, private_cost.cost_price
  FROM public.machine_private_costs AS private_cost
  LEFT JOIN public.machines AS machine ON machine.id::text = private_cost.machine_id
  WHERE actor_is_admin IS TRUE OR machine.is_hidden IS FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_catalog_machine_cost(
  p_machine_id text,
  p_cost_price numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  product_name text;
  product_mrp numeric;
  product_sell_price numeric;
  previous_cost numeric;
  cost_row_found boolean;
  actor_is_admin boolean;
  product_is_hidden boolean;
  changed_at_value timestamptz := now();
BEGIN
  SELECT COALESCE(profile.is_admin, false) INTO actor_is_admin
  FROM public.profiles AS profile
  WHERE profile.user_id = auth.uid();

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles AS profile
    WHERE profile.user_id = auth.uid()
      AND (profile.is_admin IS TRUE OR profile.can_manage_catalog IS TRUE)
  ) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT machine.name, machine.mrp, machine.sell_price, machine.is_hidden
  INTO product_name, product_mrp, product_sell_price, product_is_hidden
  FROM public.machines AS machine
  WHERE machine.id::text = p_machine_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Catalog product not found' USING ERRCODE = 'P0002';
  END IF;

  IF actor_is_admin IS NOT TRUE AND product_is_hidden IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'Catalog staff cannot edit hidden products' USING ERRCODE = '42501';
  END IF;

  IF p_cost_price < 0 THEN
    RAISE EXCEPTION 'Cost price cannot be negative' USING ERRCODE = '22003';
  END IF;

  SELECT private_cost.cost_price
  INTO previous_cost
  FROM public.machine_private_costs AS private_cost
  WHERE private_cost.machine_id = p_machine_id;
  cost_row_found := FOUND;

  IF NOT cost_row_found THEN
    SELECT machine.cost_price
    INTO previous_cost
    FROM public.machines AS machine
    WHERE machine.id::text = p_machine_id;
  END IF;

  IF previous_cost IS DISTINCT FROM p_cost_price THEN
    INSERT INTO public.machine_private_costs (machine_id, cost_price)
    VALUES (p_machine_id, p_cost_price)
    ON CONFLICT (machine_id) DO UPDATE
    SET cost_price = EXCLUDED.cost_price;

    INSERT INTO public.machine_price_history (
      machine_id,
      product_name,
      changed_at,
      old_prices,
      new_prices,
      changed_fields,
      previous_values_known
    ) VALUES (
      p_machine_id,
      product_name,
      changed_at_value,
      jsonb_build_object(
        'mrp', product_mrp,
        'sell_price', product_sell_price,
        'cost_price', previous_cost
      ),
      jsonb_build_object(
        'mrp', product_mrp,
        'sell_price', product_sell_price,
        'cost_price', p_cost_price
      ),
      ARRAY['cost_price']::text[],
      true
    );

    UPDATE public.machines AS machine
    SET price_updated_at = changed_at_value,
        price_change_count = COALESCE(machine.price_change_count, 0) + 1
    WHERE machine.id::text = p_machine_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.get_catalog_machine_costs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_catalog_machine_costs() TO authenticated;
REVOKE ALL ON FUNCTION public.set_catalog_machine_cost(text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_catalog_machine_cost(text, numeric) TO authenticated;
