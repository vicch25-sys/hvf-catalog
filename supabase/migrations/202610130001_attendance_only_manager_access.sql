-- Share attendance without exposing salary, advance, address, or contact data.
CREATE TABLE IF NOT EXISTS public.attendance_employee_directory (
  employee_id text PRIMARY KEY,
  employee_name text NOT NULL,
  employee_type text NOT NULL CHECK (employee_type IN ('contractual', 'non_contractual')),
  branch text NOT NULL DEFAULT '',
  joining_date date,
  weekly_off text NOT NULL DEFAULT 'none',
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.attendance_records (
  attendance_date date NOT NULL,
  employee_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('present', 'absent', 'halfday', 'weekoff', 'publicholiday')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id),
  PRIMARY KEY (attendance_date, employee_id)
);

CREATE TABLE IF NOT EXISTS public.attendance_day_saves (
  attendance_date date PRIMARY KEY,
  saved_at timestamptz NOT NULL,
  saved_by uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.attendance_change_history (
  id text PRIMARY KEY,
  attendance_date date NOT NULL,
  employee_id text,
  employee_name text NOT NULL DEFAULT '',
  previous_status text,
  new_status text,
  event_type text NOT NULL DEFAULT 'status',
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NOT NULL DEFAULT ''
);

ALTER TABLE public.attendance_employee_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_day_saves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_change_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.attendance_employee_directory FROM PUBLIC, anon;
REVOKE ALL ON public.attendance_records FROM PUBLIC, anon;
REVOKE ALL ON public.attendance_day_saves FROM PUBLIC, anon;
REVOKE ALL ON public.attendance_change_history FROM PUBLIC, anon;

GRANT SELECT ON public.attendance_employee_directory TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_records TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_day_saves TO authenticated;
GRANT SELECT, INSERT ON public.attendance_change_history TO authenticated;

DROP POLICY IF EXISTS "Attendance staff can read employee directory" ON public.attendance_employee_directory;
CREATE POLICY "Attendance staff can read employee directory"
  ON public.attendance_employee_directory FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));

DROP POLICY IF EXISTS "Admins can manage attendance directory" ON public.attendance_employee_directory;
CREATE POLICY "Admins can manage attendance directory"
  ON public.attendance_employee_directory FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() AND p.is_admin IS TRUE
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() AND p.is_admin IS TRUE
  ));

DROP POLICY IF EXISTS "Attendance staff can read records" ON public.attendance_records;
CREATE POLICY "Attendance staff can read records"
  ON public.attendance_records FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));
DROP POLICY IF EXISTS "Attendance staff can add records" ON public.attendance_records;
CREATE POLICY "Attendance staff can add records"
  ON public.attendance_records FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));
DROP POLICY IF EXISTS "Attendance staff can update records" ON public.attendance_records;
CREATE POLICY "Attendance staff can update records"
  ON public.attendance_records FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));
DROP POLICY IF EXISTS "Attendance staff can clear records" ON public.attendance_records;
CREATE POLICY "Attendance staff can clear records"
  ON public.attendance_records FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));

DROP POLICY IF EXISTS "Attendance staff can read day saves" ON public.attendance_day_saves;
CREATE POLICY "Attendance staff can read day saves"
  ON public.attendance_day_saves FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));
DROP POLICY IF EXISTS "Attendance staff can add day saves" ON public.attendance_day_saves;
CREATE POLICY "Attendance staff can add day saves"
  ON public.attendance_day_saves FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));
DROP POLICY IF EXISTS "Attendance staff can update day saves" ON public.attendance_day_saves;
CREATE POLICY "Attendance staff can update day saves"
  ON public.attendance_day_saves FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));
DROP POLICY IF EXISTS "Attendance staff can delete day saves" ON public.attendance_day_saves;
CREATE POLICY "Attendance staff can delete day saves"
  ON public.attendance_day_saves FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));

DROP POLICY IF EXISTS "Attendance staff can read history" ON public.attendance_change_history;
CREATE POLICY "Attendance staff can read history"
  ON public.attendance_change_history FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));
DROP POLICY IF EXISTS "Attendance staff can add history" ON public.attendance_change_history;
CREATE POLICY "Attendance staff can add history"
  ON public.attendance_change_history FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND (p.is_admin IS TRUE OR p.can_manage_catalog IS TRUE)
  ));

-- Only the admin can publish the minimal employee directory. The RPC accepts
-- no payroll fields; attendance staff can never read payroll_shared_state.
CREATE OR REPLACE FUNCTION public.sync_attendance_employee_directory(p_employees jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  employee jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() AND p.is_admin IS TRUE
  ) THEN
    RAISE EXCEPTION 'Only admins can publish the attendance employee directory' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(p_employees) <> 'array' THEN
    RAISE EXCEPTION 'Employee directory must be a JSON array' USING ERRCODE = '22023';
  END IF;

  UPDATE public.attendance_employee_directory SET is_active = false, updated_at = now();
  FOR employee IN SELECT value FROM jsonb_array_elements(p_employees)
  LOOP
    INSERT INTO public.attendance_employee_directory (
      employee_id, employee_name, employee_type, branch, joining_date, weekly_off, is_active, updated_at
    ) VALUES (
      employee->>'id',
      COALESCE(employee->>'name', ''),
      employee->>'type',
      COALESCE(employee->>'branch', ''),
      NULLIF(employee->>'joining_date', '')::date,
      COALESCE(NULLIF(employee->>'weekly_off', ''), 'none'),
      COALESCE(employee->>'status', 'active') = 'active',
      now()
    )
    ON CONFLICT (employee_id) DO UPDATE SET
      employee_name = EXCLUDED.employee_name,
      employee_type = EXCLUDED.employee_type,
      branch = EXCLUDED.branch,
      joining_date = EXCLUDED.joining_date,
      weekly_off = EXCLUDED.weekly_off,
      is_active = EXCLUDED.is_active,
      updated_at = now();
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_attendance_employee_directory(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_attendance_employee_directory(jsonb) TO authenticated;

-- Migrate the existing admin-only snapshot into the attendance-only tables.
DO $$
DECLARE
  snapshot jsonb;
  employee jsonb;
  item record;
BEGIN
  SELECT payload INTO snapshot FROM public.payroll_shared_state WHERE id = 'primary';
  IF snapshot IS NULL THEN RETURN; END IF;

  FOR employee IN
    SELECT value FROM jsonb_array_elements(COALESCE(snapshot->'hvf.payrollEmployees', '[]'::jsonb))
  LOOP
    INSERT INTO public.attendance_employee_directory (
      employee_id, employee_name, employee_type, branch, joining_date, weekly_off, is_active
    ) VALUES (
      employee->>'id', COALESCE(employee->>'name', ''), employee->>'type',
      COALESCE(employee->>'branch', ''), NULLIF(employee->>'joining_date', '')::date,
      COALESCE(NULLIF(employee->>'weekly_off', ''), 'none'),
      COALESCE(employee->>'status', 'active') = 'active'
    ) ON CONFLICT (employee_id) DO UPDATE SET
      employee_name = EXCLUDED.employee_name,
      employee_type = EXCLUDED.employee_type,
      branch = EXCLUDED.branch,
      joining_date = EXCLUDED.joining_date,
      weekly_off = EXCLUDED.weekly_off,
      is_active = EXCLUDED.is_active;
  END LOOP;

  FOR item IN
    SELECT key, value FROM jsonb_each(COALESCE(snapshot->'hvf.attendanceEntries', '{}'::jsonb))
    WHERE key ~ '^\d{4}-\d{2}-\d{2}_.+$'
      AND key !~ '^\d{4}-\d{2}-\d{2}_saved_at$'
      AND value #>> '{}' IN ('present', 'absent', 'halfday', 'weekoff', 'publicholiday')
  LOOP
    INSERT INTO public.attendance_records (attendance_date, employee_id, status)
    VALUES (split_part(item.key, '_', 1)::date, substring(item.key FROM 12), item.value #>> '{}')
    ON CONFLICT (attendance_date, employee_id) DO UPDATE SET status = EXCLUDED.status;
  END LOOP;

  FOR item IN
    SELECT key, value FROM jsonb_each(COALESCE(snapshot->'hvf.attendanceEntries', '{}'::jsonb))
    WHERE key ~ '^\d{4}-\d{2}-\d{2}_saved_at$'
  LOOP
    INSERT INTO public.attendance_day_saves (attendance_date, saved_at)
    VALUES (split_part(item.key, '_', 1)::date, (item.value #>> '{}')::timestamptz)
    ON CONFLICT (attendance_date) DO UPDATE SET saved_at = EXCLUDED.saved_at;
  END LOOP;

  FOR item IN
    SELECT value FROM jsonb_array_elements(COALESCE(snapshot->'hvf.attendanceHistory', '[]'::jsonb))
  LOOP
    INSERT INTO public.attendance_change_history (
      id, attendance_date, employee_id, employee_name, previous_status, new_status,
      event_type, changed_at, changed_by
    ) VALUES (
      'legacy:' || COALESCE(item.value->>'id', md5(item.value::text)),
      (item.value->>'date')::date,
      NULLIF(item.value->>'employee_id', ''),
      COALESCE(item.value->>'employee_name', ''),
      NULLIF(item.value->>'previous_status', ''), NULLIF(item.value->>'new_status', ''),
      COALESCE(item.value->>'type', 'status'),
      COALESCE(NULLIF(item.value->>'changed_at', '')::timestamptz, now()),
      COALESCE(item.value->>'changed_by', '')
    ) ON CONFLICT (id) DO NOTHING;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'attendance_records'
  ) THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_records; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'attendance_change_history'
  ) THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_change_history; END IF;
END;
$$;
