-- Give specifically approved, authenticated staff the ability to add and edit
-- visible catalog products and upload replacement images without admin rights.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_manage_catalog boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.profiles TO authenticated;
DROP POLICY IF EXISTS "Users can read own product-creator permission"
  ON public.profiles;
CREATE POLICY "Users can read own product-creator permission"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Do not let a user grant the product-creator capability to themselves.
REVOKE UPDATE ON public.profiles FROM PUBLIC, anon, authenticated;

REVOKE INSERT ON public.machines FROM PUBLIC, anon, authenticated;
GRANT INSERT (name, category, mrp, sell_price, is_hidden, specs, image_url)
  ON public.machines TO authenticated;
DROP POLICY IF EXISTS "Product creators can insert catalog machines"
  ON public.machines;
CREATE POLICY "Product creators can insert catalog machines"
  ON public.machines
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_hidden IS FALSE
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND (
          profile.is_admin IS TRUE
          OR profile.can_manage_catalog IS TRUE
        )
    )
  );

-- Staff can edit visible catalog fields, while hidden products and deletion
-- remain admin-only. Cost prices are read and written through the protected RPC.
REVOKE UPDATE ON public.machines FROM PUBLIC, anon, authenticated;
GRANT UPDATE (name, category, mrp, sell_price, is_hidden, specs, image_url)
  ON public.machines TO authenticated;
DROP POLICY IF EXISTS "Catalog staff can update visible machines"
  ON public.machines;
CREATE POLICY "Catalog staff can update visible machines"
  ON public.machines
  FOR UPDATE
  TO authenticated
  USING (
    is_hidden IS FALSE
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND profile.can_manage_catalog IS TRUE
    )
  )
  WITH CHECK (
    is_hidden IS FALSE
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND profile.can_manage_catalog IS TRUE
    )
  );

GRANT INSERT ON storage.objects TO authenticated;
-- Remove older permissive image-upload rules so only approved catalog
-- creators and admins can upload into the product image folder.
DROP POLICY IF EXISTS "Clients can upload images"
  ON storage.objects;
DROP POLICY IF EXISTS "Clients can upload images 1ffg0oo_0"
  ON storage.objects;
DROP POLICY IF EXISTS "auth can update own images"
  ON storage.objects;
DROP POLICY IF EXISTS "Catalog staff can replace catalog images"
  ON storage.objects;
DROP POLICY IF EXISTS "Product creators can upload catalog images"
  ON storage.objects;
CREATE POLICY "Product creators can upload catalog images"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'images'
    AND (storage.foldername(name))[1] = 'products'
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND (
          profile.is_admin IS TRUE
          OR profile.can_manage_catalog IS TRUE
        )
    )
  );

CREATE POLICY "Catalog staff can replace catalog images"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'images'
    AND (storage.foldername(name))[1] = 'products'
    AND owner = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND (profile.is_admin IS TRUE OR profile.can_manage_catalog IS TRUE)
    )
  )
  WITH CHECK (
    bucket_id = 'images'
    AND (storage.foldername(name))[1] = 'products'
    AND owner = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.user_id = auth.uid()
        AND (profile.is_admin IS TRUE OR profile.can_manage_catalog IS TRUE)
    )
  );
