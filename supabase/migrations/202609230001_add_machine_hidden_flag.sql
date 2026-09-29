ALTER TABLE public.machines
ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
