CREATE OR REPLACE FUNCTION public.restore_clinic_backup(p_backup jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_table text;
  v_rows jsonb;
  v_profiles integer := 0;
  v_pets integer := 0;
  v_appointments integer := 0;
  v_medical_records integer := 0;
  v_services integer := 0;
  v_activity integer := 0;
BEGIN
  IF p_backup IS NULL
    OR p_backup ->> 'format' <> 'pata-andina-backup'
    OR p_backup ->> 'version' <> '1'
    OR pg_catalog.jsonb_typeof(p_backup -> 'tables') <> 'object' THEN
    RAISE EXCEPTION 'El archivo no es un respaldo válido de Pata Andina';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'profiles','pets','appointment_requests',
    'pet_medical_records','services_catalog','clinic_activity_log'
  ] LOOP
    v_rows := coalesce(p_backup -> 'tables' -> v_table, '[]'::jsonb);
    IF pg_catalog.jsonb_typeof(v_rows) <> 'array'
      OR pg_catalog.jsonb_array_length(v_rows) > 10000 THEN
      RAISE EXCEPTION 'La sección % del respaldo no es válida', v_table;
    END IF;
  END LOOP;

  PERFORM pg_catalog.set_config('pata_andina.backup_restore', 'on', true);

  INSERT INTO public.profiles (id, full_name, phone, created_at, updated_at)
  SELECT x.id, x.full_name, x.phone, x.created_at, x.updated_at
  FROM pg_catalog.jsonb_populate_recordset(
    NULL::public.profiles,
    coalesce(p_backup -> 'tables' -> 'profiles', '[]'::jsonb)
  ) AS x
  WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = x.id)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_profiles = ROW_COUNT;

  INSERT INTO public.pets (
    id, owner_id, name, species, breed, age_text, weight_kg, notes, created_at, updated_at
  )
  SELECT x.id, x.owner_id, x.name, x.species, x.breed, x.age_text,
         x.weight_kg, x.notes, x.created_at, x.updated_at
  FROM pg_catalog.jsonb_populate_recordset(
    NULL::public.pets,
    coalesce(p_backup -> 'tables' -> 'pets', '[]'::jsonb)
  ) AS x
  WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = x.owner_id)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_pets = ROW_COUNT;

  INSERT INTO public.appointment_requests (
    id, owner_id, pet_id, owner_name, owner_phone, owner_email, pet_name, species,
    pet_age, service_id, service_name, price_label, price_source_url, duration_minutes,
    requested_date, requested_time, notes, status, created_at, updated_at
  )
  SELECT x.id, x.owner_id, x.pet_id, x.owner_name, x.owner_phone, x.owner_email,
         x.pet_name, x.species, x.pet_age, x.service_id, x.service_name, x.price_label,
         x.price_source_url, x.duration_minutes, x.requested_date, x.requested_time,
         x.notes, x.status, x.created_at, x.updated_at
  FROM pg_catalog.jsonb_populate_recordset(
    NULL::public.appointment_requests,
    coalesce(p_backup -> 'tables' -> 'appointment_requests', '[]'::jsonb)
  ) AS x
  WHERE (x.owner_id IS NULL OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = x.owner_id))
    AND (x.pet_id IS NULL OR EXISTS (SELECT 1 FROM public.pets p WHERE p.id = x.pet_id))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_appointments = ROW_COUNT;

  INSERT INTO public.pet_medical_records (
    id, pet_id, appointment_request_id, recorded_by, record_date, record_type,
    summary, diagnosis, treatment, prescriptions, next_visit_date, created_at
  )
  SELECT x.id, x.pet_id, x.appointment_request_id, x.recorded_by, x.record_date,
         x.record_type, x.summary, x.diagnosis, x.treatment, x.prescriptions,
         x.next_visit_date, x.created_at
  FROM pg_catalog.jsonb_populate_recordset(
    NULL::public.pet_medical_records,
    coalesce(p_backup -> 'tables' -> 'pet_medical_records', '[]'::jsonb)
  ) AS x
  WHERE EXISTS (SELECT 1 FROM public.pets p WHERE p.id = x.pet_id)
    AND (x.appointment_request_id IS NULL OR EXISTS (
      SELECT 1 FROM public.appointment_requests a WHERE a.id = x.appointment_request_id
    ))
    AND (x.recorded_by IS NULL OR EXISTS (
      SELECT 1 FROM auth.users u WHERE u.id = x.recorded_by
    ))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_medical_records = ROW_COUNT;

  INSERT INTO public.services_catalog (
    id, name, category, description, details, duration_minutes, price_value, price_label,
    tag, image, species, image_alt, fallback_image, display_order, price_source_url, active, updated_at
  )
  SELECT x.id, x.name, x.category, x.description, x.details, x.duration_minutes,
         x.price_value, x.price_label, x.tag, x.image, x.species, x.image_alt,
         x.fallback_image, x.display_order, x.price_source_url, x.active, x.updated_at
  FROM pg_catalog.jsonb_populate_recordset(
    NULL::public.services_catalog,
    coalesce(p_backup -> 'tables' -> 'services_catalog', '[]'::jsonb)
  ) AS x
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_services = ROW_COUNT;

  INSERT INTO public.clinic_activity_log (
    id, event_type, entity_type, entity_id, actor_id, event_summary, details, created_at
  )
  SELECT x.id, x.event_type, x.entity_type, x.entity_id, x.actor_id,
         x.event_summary, x.details, x.created_at
  FROM pg_catalog.jsonb_populate_recordset(
    NULL::public.clinic_activity_log,
    coalesce(p_backup -> 'tables' -> 'clinic_activity_log', '[]'::jsonb)
  ) AS x
  WHERE x.actor_id IS NULL OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = x.actor_id)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_activity = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object(
    'strategy', 'missing-only',
    'restored', pg_catalog.jsonb_build_object(
      'profiles', v_profiles,
      'pets', v_pets,
      'appointment_requests', v_appointments,
      'pet_medical_records', v_medical_records,
      'services_catalog', v_services,
      'clinic_activity_log', v_activity
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.restore_clinic_backup(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_clinic_backup(jsonb) TO service_role;
