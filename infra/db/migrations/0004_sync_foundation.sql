-- 0004: base de la sincronización (Etapa 2a)
-- Contador de secuencia por organización, columnas comunes mantenidas por la base de datos,
-- registro de operaciones (idempotencia), conflictos y la primera entidad sincronizable: vehicles.

-- ===================== Contador de secuencia =====================
-- El servidor ordena los cambios con este contador, no con relojes de dispositivos.
-- La fila del contador queda bloqueada hasta el fin de la transacción: el orden de las
-- secuencias coincide con el orden de confirmación y el pull nunca se salta cambios.
CREATE TABLE public.sync_counters (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  last_seq        bigint NOT NULL DEFAULT 0
);
ALTER TABLE public.sync_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_counters FORCE ROW LEVEL SECURITY;
-- Sin políticas ni permisos para la aplicación: solo se toca vía app.next_sync_seq().

CREATE FUNCTION app.next_sync_seq(p_org uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.sync_counters AS c (organization_id, last_seq) VALUES (p_org, 1)
  ON CONFLICT (organization_id) DO UPDATE SET last_seq = c.last_seq + 1
  RETURNING last_seq
$$;

-- ===================== Columnas comunes mantenidas por la base =====================
-- El cliente no puede falsear versión, secuencia, autor ni dispositivo de origen.
CREATE FUNCTION app.sync_record_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app.organization_id() IS NOT NULL THEN
      NEW.organization_id := app.organization_id();
    END IF;
    NEW.version           := 1;
    NEW.created_at        := now();
    NEW.updated_at        := now();
    NEW.created_by        := app.user_id();
    NEW.updated_by        := app.user_id();
    NEW.created_device_id := app.device_id();
    NEW.updated_device_id := app.device_id();
    NEW.deleted_at        := NULL;
    NEW.deleted_by        := NULL;
    NEW.delete_reason     := NULL;
    NEW.server_seq        := app.next_sync_seq(NEW.organization_id);
  ELSE
    IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
       OR NEW.created_at <> OLD.created_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_device_id IS DISTINCT FROM OLD.created_device_id THEN
      RAISE EXCEPTION 'Campos inmutables de un registro sincronizable' USING ERRCODE = '42501';
    END IF;
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'No se puede modificar ni restaurar un registro eliminado' USING ERRCODE = '42501';
    END IF;
    NEW.version           := OLD.version + 1;
    NEW.updated_at        := now();
    NEW.updated_by        := app.user_id();
    NEW.updated_device_id := app.device_id();
    IF NEW.deleted_at IS NOT NULL THEN
      NEW.deleted_at := now();
      NEW.deleted_by := app.user_id();
    END IF;
    NEW.server_seq := app.next_sync_seq(NEW.organization_id);
  END IF;
  RETURN NEW;
END $$;

-- Cambios de negocio hechos a un registro después de cierta versión (según el historial de auditoría).
CREATE FUNCTION app.fields_changed_since(p_table text, p_entity uuid, p_version integer) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT f), ARRAY[]::text[])
    FROM public.audit_log a, unnest(a.changed_fields) AS f
   WHERE a.organization_id = app.organization_id()
     AND a.entity_type = p_table
     AND a.entity_id = p_entity
     AND a.action = 'UPDATE'
     AND (a.new_data ->> 'version')::integer > p_version
     AND f NOT IN ('version', 'server_seq', 'updated_at', 'updated_by', 'updated_device_id', 'client_updated_at')
$$;

-- ===================== Conflictos y operaciones =====================
CREATE TABLE public.sync_conflicts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id),
  entity_type         text NOT NULL,
  entity_id           uuid NOT NULL,
  conflict_type       text NOT NULL CHECK (conflict_type IN
    ('version','bloqueado','duplicado_probable','solapamiento','continuidad','eliminado_remoto','permiso','dispositivo_revocado')),
  operation_id        uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('create','update','delete')),
  device_id           uuid NOT NULL REFERENCES public.devices(id),
  user_id             uuid NOT NULL REFERENCES public.users(id),
  server_version      integer,
  client_base_version integer,
  server_snapshot     jsonb,
  client_patch        jsonb NOT NULL,
  conflicting_fields  text[],
  status              text NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto','resuelto','descartado')),
  resolution          text CHECK (resolution IN ('servidor','cliente','manual')),
  resolved_by         uuid REFERENCES public.users(id),
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_conflicts_org_status_idx ON public.sync_conflicts (organization_id, status);
CREATE INDEX sync_conflicts_user_idx ON public.sync_conflicts (user_id);

CREATE TABLE public.sync_operations (
  operation_id      uuid PRIMARY KEY,
  organization_id   uuid NOT NULL REFERENCES public.organizations(id),
  device_id         uuid NOT NULL REFERENCES public.devices(id),
  user_id           uuid NOT NULL REFERENCES public.users(id),
  device_seq        bigint,
  entity_type       text NOT NULL,
  entity_id         uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('create','update','delete')),
  base_version      integer,
  result            text NOT NULL CHECK (result IN ('aplicada','conflicto','rechazada')),
  resulting_version integer,
  server_seq        bigint,
  conflict_id       uuid REFERENCES public.sync_conflicts(id),
  reason            text,
  merged            boolean NOT NULL DEFAULT false,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_operations_device_idx ON public.sync_operations (device_id);

-- ===================== Entidad piloto: vehículos =====================
CREATE TABLE public.vehicles (
  id                uuid PRIMARY KEY,
  organization_id   uuid NOT NULL REFERENCES public.organizations(id),
  plate             text NOT NULL CHECK (plate ~ '^[A-Z0-9-]{3,12}$'),
  brand             text CHECK (brand IS NULL OR char_length(brand) BETWEEN 1 AND 60),
  model             text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 60),
  vehicle_year      integer CHECK (vehicle_year IS NULL OR vehicle_year BETWEEN 1950 AND 2100),
  notes             text CHECK (notes IS NULL OR char_length(notes) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  client_created_at timestamptz,
  client_updated_at timestamptz,
  created_by        uuid REFERENCES public.users(id),
  updated_by        uuid REFERENCES public.users(id),
  created_device_id uuid REFERENCES public.devices(id),
  updated_device_id uuid REFERENCES public.devices(id),
  version           integer NOT NULL DEFAULT 1,
  server_seq        bigint NOT NULL,
  deleted_at        timestamptz,
  deleted_by        uuid REFERENCES public.users(id),
  delete_reason     text CHECK (delete_reason IS NULL OR char_length(delete_reason) <= 200)
);
CREATE UNIQUE INDEX vehicles_plate_uq ON public.vehicles (organization_id, plate) WHERE deleted_at IS NULL;
CREATE INDEX vehicles_sync_idx ON public.vehicles (organization_id, server_seq);

CREATE FUNCTION app.vehicle_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND app.user_id() IS NOT NULL
     AND app.permission_scope('vehicle', 'approve') IS DISTINCT FROM 'all' THEN
    RAISE EXCEPTION 'Dar de baja un vehículo requiere vehicle:approve' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- El nombre del guard va antes que el de sync para que se evalúe primero.
CREATE TRIGGER vehicles_delete_guard BEFORE UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION app.vehicle_delete_guard();
CREATE TRIGGER vehicles_sync BEFORE INSERT OR UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION app.sync_record_trigger();
CREATE TRIGGER audit_vehicles AFTER INSERT OR UPDATE OR DELETE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

-- ===================== RLS =====================
ALTER TABLE public.vehicles        ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.vehicles        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sync_conflicts  ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.sync_conflicts  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sync_operations ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.sync_operations FORCE ROW LEVEL SECURITY;

-- Alcance 'all': los alcances 'assigned' y 'own' de vehículos se resuelven con las asignaciones (Etapa 3).
CREATE POLICY vehicles_select ON public.vehicles FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (SELECT app.permission_scope('vehicle', 'read')) = 'all');
CREATE POLICY vehicles_insert ON public.vehicles FOR INSERT TO sgv_app
  WITH CHECK (organization_id = (SELECT app.organization_id())
              AND (SELECT app.permission_scope('vehicle', 'create')) = 'all');
CREATE POLICY vehicles_update ON public.vehicles FOR UPDATE TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND ((SELECT app.permission_scope('vehicle', 'update')) = 'all'
              OR (SELECT app.permission_scope('vehicle', 'approve')) = 'all'))
  WITH CHECK (organization_id = (SELECT app.organization_id())
              AND ((SELECT app.permission_scope('vehicle', 'update')) = 'all'
                   OR (SELECT app.permission_scope('vehicle', 'approve')) = 'all'));

CREATE POLICY sync_operations_select ON public.sync_operations FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id()) AND user_id = (SELECT app.user_id()));
CREATE POLICY sync_operations_insert ON public.sync_operations FOR INSERT TO sgv_app
  WITH CHECK (organization_id = (SELECT app.organization_id())
              AND user_id = (SELECT app.user_id())
              AND device_id = (SELECT app.device_id()));

CREATE POLICY sync_conflicts_select ON public.sync_conflicts FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (user_id = (SELECT app.user_id())
              OR (SELECT app.permission_scope('conflict', 'resolve')) IS NOT NULL));
CREATE POLICY sync_conflicts_insert ON public.sync_conflicts FOR INSERT TO sgv_app
  WITH CHECK (organization_id = (SELECT app.organization_id()) AND user_id = (SELECT app.user_id()));
CREATE POLICY sync_conflicts_update ON public.sync_conflicts FOR UPDATE TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (user_id = (SELECT app.user_id())
              OR (SELECT app.permission_scope('conflict', 'resolve')) IS NOT NULL))
  WITH CHECK (organization_id = (SELECT app.organization_id()));

-- ===================== Privilegios =====================
GRANT SELECT, INSERT, UPDATE ON public.vehicles TO sgv_app;
GRANT SELECT, INSERT ON public.sync_operations TO sgv_app;
GRANT SELECT, INSERT ON public.sync_conflicts TO sgv_app;
GRANT UPDATE (status, resolution, resolved_by, resolved_at) ON public.sync_conflicts TO sgv_app;

REVOKE ALL ON FUNCTION app.next_sync_seq(uuid), app.sync_record_trigger(),
  app.fields_changed_since(text, uuid, integer), app.vehicle_delete_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.fields_changed_since(text, uuid, integer) TO sgv_app;
