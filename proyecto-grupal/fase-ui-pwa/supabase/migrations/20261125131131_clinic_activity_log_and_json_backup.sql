CREATE TABLE public.clinic_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN (
    'tutor_profile_created','pet_registered','appointment_requested',
    'appointment_status_changed','medical_record_added'
  )),
  entity_type text NOT NULL CHECK (entity_type IN ('profile','pet','appointment','medical_record')),
  entity_id uuid NOT NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_summary text NOT NULL CHECK (char_length(event_summary) BETWEEN 2 AND 180),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX clinic_activity_log_created_at_idx ON public.clinic_activity_log (created_at DESC, id DESC);
ALTER TABLE public.clinic_activity_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.clinic_activity_log FROM anon, authenticated;
GRANT SELECT ON TABLE public.clinic_activity_log TO authenticated;
CREATE POLICY clinic_activity_log_staff_read ON public.clinic_activity_log FOR SELECT TO authenticated
  USING ((SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'staff');

CREATE OR REPLACE FUNCTION private.log_clinic_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_event_type text;
  v_entity_type text;
  v_entity_id uuid;
  v_summary text;
  v_details jsonb := '{}'::jsonb;
BEGIN
  IF pg_catalog.current_setting('pata_andina.backup_restore', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'profiles' AND TG_OP = 'INSERT' THEN
    v_event_type := 'tutor_profile_created'; v_entity_type := 'profile'; v_entity_id := NEW.id;
    v_summary := 'Se creó un perfil de tutor.';
  ELSIF TG_TABLE_NAME = 'pets' AND TG_OP = 'INSERT' THEN
    v_event_type := 'pet_registered'; v_entity_type := 'pet'; v_entity_id := NEW.id;
    v_summary := 'Se registró una mascota.';
  ELSIF TG_TABLE_NAME = 'appointment_requests' AND TG_OP = 'INSERT' THEN
    v_event_type := 'appointment_requested'; v_entity_type := 'appointment'; v_entity_id := NEW.id;
    v_summary := 'Se recibió una solicitud de turno.';
  ELSIF TG_TABLE_NAME = 'appointment_requests' AND TG_OP = 'UPDATE' THEN
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
    v_event_type := 'appointment_status_changed'; v_entity_type := 'appointment'; v_entity_id := NEW.id;
    v_summary := 'Se actualizó el estado de una solicitud.';
    v_details := pg_catalog.jsonb_build_object('from', OLD.status, 'to', NEW.status);
  ELSIF TG_TABLE_NAME = 'pet_medical_records' AND TG_OP = 'INSERT' THEN
    v_event_type := 'medical_record_added'; v_entity_type := 'medical_record'; v_entity_id := NEW.id;
    v_summary := 'Se registró una atención médica.';
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO public.clinic_activity_log(event_type,entity_type,entity_id,actor_id,event_summary,details)
  VALUES (v_event_type,v_entity_type,v_entity_id,auth.uid(),v_summary,v_details);
  PERFORM pg_catalog.pg_advisory_xact_lock(20261125,200);
  DELETE FROM public.clinic_activity_log
  WHERE id IN (SELECT id FROM public.clinic_activity_log ORDER BY created_at DESC,id DESC OFFSET 200);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.log_clinic_activity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER profiles_activity_insert AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.log_clinic_activity();
CREATE TRIGGER pets_activity_insert AFTER INSERT ON public.pets
  FOR EACH ROW EXECUTE FUNCTION private.log_clinic_activity();
CREATE TRIGGER appointments_activity_insert AFTER INSERT ON public.appointment_requests
  FOR EACH ROW EXECUTE FUNCTION private.log_clinic_activity();
CREATE TRIGGER appointments_activity_status_update AFTER UPDATE OF status ON public.appointment_requests
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION private.log_clinic_activity();
CREATE TRIGGER medical_records_activity_insert AFTER INSERT ON public.pet_medical_records
  FOR EACH ROW EXECUTE FUNCTION private.log_clinic_activity();

CREATE OR REPLACE FUNCTION private.prevent_appointment_overlap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE local_today date; phone_requests integer; selected_service public.services_catalog%rowtype;
BEGIN
  IF current_setting('pata_andina.backup_restore', true) = 'on' THEN RETURN NEW; END IF;
  local_today := (clock_timestamp() at time zone 'America/La_Paz')::date;
  IF tg_op = 'INSERT' THEN
    SELECT * INTO selected_service FROM public.services_catalog WHERE id = new.service_id AND active = true;
    IF NOT FOUND THEN RAISE EXCEPTION 'El servicio seleccionado ya no está disponible'; END IF;
    new.service_name := selected_service.name;
    new.price_label := selected_service.price_label;
    new.price_source_url := selected_service.price_source_url;
    new.duration_minutes := selected_service.duration_minutes;
    new.status := 'requested';
  END IF;
  IF new.status IN ('requested','confirmed') THEN
    IF new.requested_date < local_today THEN RAISE EXCEPTION 'La fecha solicitada ya pasó'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(new.requested_date::text,0));
    IF tg_op = 'INSERT' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('phone|' || new.owner_phone,0));
      SELECT count(*) INTO phone_requests FROM public.appointment_requests a
      WHERE a.owner_phone = new.owner_phone
        AND a.created_at >= clock_timestamp() - interval '24 hours'
        AND a.status <> 'cancelled';
      IF phone_requests >= 5 THEN RAISE EXCEPTION 'Se alcanzó el límite diario de solicitudes para este celular'; END IF;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.appointment_requests a
      WHERE a.id <> coalesce(new.id,'00000000-0000-0000-0000-000000000000'::uuid)
        AND a.requested_date = new.requested_date AND a.status IN ('requested','confirmed')
        AND new.requested_time < a.requested_time + make_interval(mins => a.duration_minutes)
        AND a.requested_time < new.requested_time + make_interval(mins => new.duration_minutes)
    ) THEN RAISE EXCEPTION 'El horario solicitado no está disponible'; END IF;
  END IF;
  RETURN NEW;
END;
$function$;

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
