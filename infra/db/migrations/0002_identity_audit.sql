-- 0002: identidad, permisos, dispositivos, sesiones y auditoría (Etapa 1)
-- Las funciones SECURITY DEFINER pertenecen al rol que ejecuta las migraciones. Ese rol debe
-- poder saltarse RLS (en desarrollo y CI es superusuario; en producción, un rol con BYPASSRLS).

-- ===================== Tablas =====================
CREATE TABLE public.organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE public.roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT true
);

CREATE TABLE public.permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource    text NOT NULL,
  action      text NOT NULL CHECK (action IN
                ('read','create','update','validate','approve','export','authorize','resolve','manage')),
  description text,
  UNIQUE (resource, action)
);

CREATE TABLE public.role_permissions (
  role_id       uuid NOT NULL REFERENCES public.roles(id),
  permission_id uuid NOT NULL REFERENCES public.permissions(id),
  scope         text NOT NULL CHECK (scope IN ('all','assigned','own')),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE public.users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  email           text NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
  full_name       text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
  password_hash   text NOT NULL,
  status          text NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','inactivo')),
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON public.users (email) WHERE deleted_at IS NULL;
CREATE INDEX users_org_idx ON public.users (organization_id);

CREATE TABLE public.user_roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id         uuid NOT NULL REFERENCES public.users(id),
  role_id         uuid NOT NULL REFERENCES public.roles(id),
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  assigned_by     uuid REFERENCES public.users(id),
  revoked_at      timestamptz
);
CREATE UNIQUE INDEX user_roles_active_uq ON public.user_roles (user_id, role_id) WHERE revoked_at IS NULL;
CREATE INDEX user_roles_user_idx ON public.user_roles (user_id);

CREATE TABLE public.devices (
  id                uuid PRIMARY KEY,
  organization_id   uuid NOT NULL REFERENCES public.organizations(id),
  user_id           uuid NOT NULL REFERENCES public.users(id),
  label             text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  platform          text NOT NULL CHECK (char_length(platform) BETWEEN 1 AND 40),
  status            text NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','revocado','perdido')),
  registered_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz,
  last_pulled_seq   bigint NOT NULL DEFAULT 0,
  pending_ops_count integer NOT NULL DEFAULT 0 CHECK (pending_ops_count >= 0),
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES public.users(id),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON public.devices (user_id);
CREATE INDEX devices_org_idx ON public.devices (organization_id);

CREATE TABLE public.sessions (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id         uuid NOT NULL REFERENCES public.users(id),
  device_id       uuid NOT NULL REFERENCES public.devices(id),
  token_hash      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  rotated_from    uuid REFERENCES public.sessions(id),
  revoked_at      timestamptz,
  last_used_at    timestamptz
);
CREATE INDEX sessions_device_idx ON public.sessions (device_id);
CREATE INDEX sessions_user_idx ON public.sessions (user_id);

CREATE TABLE public.audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  occurred_at     timestamptz NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid,
  action          text NOT NULL CHECK (action ~ '^[A-Z_]{3,40}$'),
  changed_fields  text[],
  old_data        jsonb,
  new_data        jsonb,
  user_id         uuid,
  device_id       uuid,
  data            jsonb,
  prev_hash       text,
  row_hash        text NOT NULL
);
CREATE INDEX audit_log_org_idx ON public.audit_log (organization_id, id);
CREATE INDEX audit_log_entity_idx ON public.audit_log (entity_type, entity_id);

-- ===================== Funciones =====================
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Alcance máximo (all > assigned > own) que el usuario del contexto tiene sobre recurso:acción.
-- DEFINER para no caer en recursión con las políticas de user_roles.
CREATE FUNCTION app.permission_scope(p_resource text, p_action text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
           WHEN bool_or(rp.scope = 'all')      THEN 'all'
           WHEN bool_or(rp.scope = 'assigned') THEN 'assigned'
           WHEN bool_or(rp.scope = 'own')      THEN 'own'
         END
  FROM public.user_roles ur
  JOIN public.role_permissions rp ON rp.role_id = ur.role_id
  JOIN public.permissions p ON p.id = rp.permission_id
  WHERE ur.user_id = app.user_id()
    AND ur.organization_id = app.organization_id()
    AND ur.revoked_at IS NULL
    AND p.resource = p_resource
    AND p.action = p_action
$$;

CREATE FUNCTION app.has_permission(p_resource text, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.permission_scope(p_resource, p_action) IS NOT NULL
$$;

-- Escritura única en audit_log, con hash encadenado por organización.
CREATE FUNCTION app.audit_insert(
  p_org uuid, p_entity_type text, p_entity_id uuid, p_action text, p_changed text[],
  p_old jsonb, p_new jsonb, p_user uuid, p_device uuid, p_data jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_prev text;
  v_at timestamptz := clock_timestamp();
  v_payload text;
BEGIN
  -- Serializa la cadena de esta organización hasta el fin de la transacción.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text, 0));
  SELECT row_hash INTO v_prev FROM public.audit_log
   WHERE organization_id = p_org ORDER BY id DESC LIMIT 1;
  v_payload := concat_ws('|',
    COALESCE(v_prev, ''), p_org::text,
    to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    p_entity_type, COALESCE(p_entity_id::text, ''), p_action,
    COALESCE(array_to_string(p_changed, ','), ''),
    COALESCE(p_old::text, ''), COALESCE(p_new::text, ''),
    COALESCE(p_user::text, ''), COALESCE(p_device::text, ''), COALESCE(p_data::text, ''));
  INSERT INTO public.audit_log (organization_id, occurred_at, entity_type, entity_id, action,
      changed_fields, old_data, new_data, user_id, device_id, data, prev_hash, row_hash)
  VALUES (p_org, v_at, p_entity_type, p_entity_id, p_action,
      p_changed, p_old, p_new, p_user, p_device, p_data, v_prev,
      encode(sha256(convert_to(v_payload, 'UTF8')), 'hex'));
END $$;

-- Trigger genérico: nunca guarda secretos (password_hash, token_hash).
CREATE FUNCTION app.audit_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old_full jsonb; v_new_full jsonb; v_row jsonb; v_old jsonb; v_new jsonb;
  v_changed text[]; v_action text; v_org uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_old_full := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_new_full := to_jsonb(NEW); END IF;
  v_row := COALESCE(v_new_full, v_old_full);
  v_old := v_old_full - 'password_hash' - 'token_hash';
  v_new := v_new_full - 'password_hash' - 'token_hash';

  IF TG_OP = 'INSERT' THEN
    v_action := 'CREATE';
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'DELETE';
  ELSE
    v_action := 'UPDATE';
    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
      FROM jsonb_each(v_new_full) AS n
     WHERE n.value IS DISTINCT FROM (v_old_full -> n.key);
    -- Columnas de telemetría: no son cambios de negocio y llenarían el historial.
    v_changed := ARRAY(
      SELECT c FROM unnest(v_changed) AS c
       WHERE c NOT IN ('updated_at','last_seen_at','last_login_at','last_pulled_seq',
                       'pending_ops_count','failed_attempts','locked_until'));
    IF cardinality(v_changed) = 0 THEN RETURN NULL; END IF;
  END IF;

  v_org := COALESCE((v_row ->> 'organization_id')::uuid,
                    CASE WHEN TG_TABLE_NAME = 'organizations' THEN (v_row ->> 'id')::uuid END);
  PERFORM app.audit_insert(v_org, TG_TABLE_NAME, (v_row ->> 'id')::uuid, v_action, v_changed,
                           v_old, v_new, app.user_id(), app.device_id(), NULL);
  RETURN NULL;
END $$;

CREATE FUNCTION app.audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_log es de solo inserción'; END $$;

-- Devuelve el id de la primera fila alterada de la cadena, o NULL si está íntegra.
CREATE FUNCTION app.verify_audit_chain(p_org uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record; v_prev text := NULL; v_payload text;
BEGIN
  FOR r IN SELECT * FROM public.audit_log WHERE organization_id = p_org ORDER BY id LOOP
    v_payload := concat_ws('|',
      COALESCE(v_prev, ''), r.organization_id::text,
      to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      r.entity_type, COALESCE(r.entity_id::text, ''), r.action,
      COALESCE(array_to_string(r.changed_fields, ','), ''),
      COALESCE(r.old_data::text, ''), COALESCE(r.new_data::text, ''),
      COALESCE(r.user_id::text, ''), COALESCE(r.device_id::text, ''), COALESCE(r.data::text, ''));
    IF r.prev_hash IS DISTINCT FROM v_prev
       OR r.row_hash <> encode(sha256(convert_to(v_payload, 'UTF8')), 'hex') THEN
      RETURN r.id;
    END IF;
    v_prev := r.row_hash;
  END LOOP;
  RETURN NULL;
END $$;

-- Eventos explícitos (inicio de sesión, cierre, reutilización de token...).
CREATE FUNCTION app.log_event(
  p_org uuid, p_user uuid, p_device uuid, p_action text, p_entity_type text, p_entity_id uuid, p_data jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM app.audit_insert(p_org, p_entity_type, p_entity_id, p_action, NULL, NULL, NULL, p_user, p_device, p_data);
END $$;

-- ----- Funciones previas a la autenticación (aún no hay contexto de usuario) -----
CREATE FUNCTION app.auth_find_user(p_email text)
RETURNS TABLE (id uuid, organization_id uuid, password_hash text, status text,
               failed_attempts integer, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.organization_id, u.password_hash, u.status, u.failed_attempts, u.locked_until
    FROM public.users u
   WHERE u.email = lower(p_email) AND u.deleted_at IS NULL
$$;

CREATE FUNCTION app.auth_register_failure(p_user uuid, p_max integer, p_lock_minutes integer) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.users
     SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= p_max
                             THEN now() + make_interval(mins => p_lock_minutes)
                             ELSE locked_until END
   WHERE id = p_user
$$;

CREATE FUNCTION app.auth_register_success(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.users
     SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
   WHERE id = p_user
$$;

CREATE FUNCTION app.auth_find_session(p_session uuid)
RETURNS TABLE (id uuid, organization_id uuid, user_id uuid, device_id uuid, token_hash text,
               expires_at timestamptz, revoked_at timestamptz, device_status text, user_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.organization_id, s.user_id, s.device_id, s.token_hash,
         s.expires_at, s.revoked_at, d.status, u.status
    FROM public.sessions s
    JOIN public.devices d ON d.id = s.device_id
    JOIN public.users u ON u.id = s.user_id
   WHERE s.id = p_session
$$;

-- Reutilización de un refresh token ya rotado: se invalidan todas las sesiones del dispositivo.
CREATE FUNCTION app.auth_revoke_chain(p_session uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.sessions
     SET revoked_at = now()
   WHERE revoked_at IS NULL
     AND device_id = (SELECT s.device_id FROM public.sessions s
                       WHERE s.id = p_session AND s.revoked_at IS NOT NULL)
$$;

-- Revocación de dispositivos: solo quien tiene device:manage con alcance total.
CREATE FUNCTION app.revoke_device(p_device uuid, p_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_status NOT IN ('revocado', 'perdido') THEN
    RAISE EXCEPTION 'estado inválido: %', p_status;
  END IF;
  IF app.permission_scope('device', 'manage') IS DISTINCT FROM 'all' THEN
    RAISE EXCEPTION 'permiso insuficiente' USING ERRCODE = '42501';
  END IF;
  UPDATE public.devices
     SET status = p_status, revoked_at = now(), revoked_by = app.user_id()
   WHERE id = p_device AND organization_id = app.organization_id() AND status = 'activo';
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.sessions SET revoked_at = now() WHERE device_id = p_device AND revoked_at IS NULL;
  RETURN true;
END $$;

-- Reglas fijas de segregación sobre los permisos de cada perfil.
CREATE FUNCTION app.role_permission_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_role text; v_action text; v_resource text;
BEGIN
  SELECT code INTO v_role FROM public.roles WHERE id = NEW.role_id;
  SELECT action, resource INTO v_action, v_resource FROM public.permissions WHERE id = NEW.permission_id;
  IF v_role = 'auditor' AND v_action NOT IN ('read', 'export') THEN
    RAISE EXCEPTION 'El Auditor solo puede tener consulta y exportación (%:%)', v_resource, v_action;
  END IF;
  IF v_action = 'manage' AND v_role <> 'admin_general' THEN
    RAISE EXCEPTION 'Solo el Administrador general puede tener permisos de administración (%:%)', v_resource, v_action;
  END IF;
  RETURN NEW;
END $$;

-- ===================== Triggers =====================
CREATE TRIGGER role_permissions_guard BEFORE INSERT OR UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION app.role_permission_guard();

CREATE TRIGGER users_touch BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER devices_touch BEFORE UPDATE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER audit_organizations AFTER INSERT OR UPDATE OR DELETE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER audit_users AFTER INSERT OR UPDATE OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER audit_user_roles AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();
CREATE TRIGGER audit_devices AFTER INSERT OR UPDATE OR DELETE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION app.audit_trigger();

CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_immutable();

-- ===================== RLS =====================
ALTER TABLE public.organizations     ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.organizations     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.roles             ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.roles             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.permissions       ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.permissions       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions  ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.role_permissions  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.users             ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.users             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles        ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.user_roles        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.devices           ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.devices           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sessions          ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.sessions          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log         ENABLE ROW LEVEL SECURITY;  ALTER TABLE public.audit_log         FORCE ROW LEVEL SECURITY;

CREATE POLICY organizations_select ON public.organizations FOR SELECT TO sgv_app
  USING (id = (SELECT app.organization_id()));

-- Catálogos globales: solo lectura para la aplicación (los cambia el dueño con migraciones).
CREATE POLICY roles_select ON public.roles FOR SELECT TO sgv_app, sgv_worker USING (true);
CREATE POLICY permissions_select ON public.permissions FOR SELECT TO sgv_app, sgv_worker USING (true);
CREATE POLICY role_permissions_select ON public.role_permissions FOR SELECT TO sgv_app, sgv_worker USING (true);

CREATE POLICY users_select ON public.users FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (id = (SELECT app.user_id()) OR (SELECT app.permission_scope('user', 'manage')) = 'all'));
CREATE POLICY users_insert ON public.users FOR INSERT TO sgv_app
  WITH CHECK (organization_id = (SELECT app.organization_id())
              AND (SELECT app.permission_scope('user', 'manage')) = 'all');
CREATE POLICY users_update ON public.users FOR UPDATE TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (SELECT app.permission_scope('user', 'manage')) = 'all')
  WITH CHECK (organization_id = (SELECT app.organization_id())
              AND (SELECT app.permission_scope('user', 'manage')) = 'all');

CREATE POLICY user_roles_select ON public.user_roles FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (user_id = (SELECT app.user_id()) OR (SELECT app.permission_scope('user', 'manage')) = 'all'));
CREATE POLICY user_roles_insert ON public.user_roles FOR INSERT TO sgv_app
  WITH CHECK (organization_id = (SELECT app.organization_id())
              AND (SELECT app.permission_scope('user', 'manage')) = 'all');

CREATE POLICY devices_select ON public.devices FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (user_id = (SELECT app.user_id()) OR (SELECT app.permission_scope('device', 'manage')) = 'all'));
CREATE POLICY devices_insert ON public.devices FOR INSERT TO sgv_app
  WITH CHECK (organization_id = (SELECT app.organization_id()) AND user_id = (SELECT app.user_id()));
CREATE POLICY devices_update ON public.devices FOR UPDATE TO sgv_app
  USING (organization_id = (SELECT app.organization_id()) AND user_id = (SELECT app.user_id()))
  WITH CHECK (organization_id = (SELECT app.organization_id()) AND user_id = (SELECT app.user_id()));

CREATE POLICY sessions_select ON public.sessions FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id()) AND user_id = (SELECT app.user_id()));
CREATE POLICY sessions_insert ON public.sessions FOR INSERT TO sgv_app
  WITH CHECK (organization_id = (SELECT app.organization_id()) AND user_id = (SELECT app.user_id()));
CREATE POLICY sessions_update ON public.sessions FOR UPDATE TO sgv_app
  USING (organization_id = (SELECT app.organization_id()) AND user_id = (SELECT app.user_id()))
  WITH CHECK (organization_id = (SELECT app.organization_id()) AND user_id = (SELECT app.user_id()));

-- Solo con alcance total sobre audit:read (un alcance parcial se resolverá en etapas posteriores).
CREATE POLICY audit_log_select ON public.audit_log FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (SELECT app.permission_scope('audit', 'read')) = 'all');

-- ===================== Privilegios =====================
GRANT SELECT ON public.organizations, public.roles, public.permissions, public.role_permissions TO sgv_app;
GRANT SELECT ON public.roles, public.permissions, public.role_permissions TO sgv_worker;

-- La aplicación nunca puede leer password_hash ni los contadores de bloqueo.
GRANT SELECT (id, organization_id, email, full_name, status, mfa_enabled, last_login_at,
              created_at, updated_at, deleted_at) ON public.users TO sgv_app;
GRANT INSERT (organization_id, email, full_name, password_hash) ON public.users TO sgv_app;
GRANT UPDATE (full_name, status) ON public.users TO sgv_app;

GRANT SELECT ON public.user_roles TO sgv_app;
GRANT INSERT (organization_id, user_id, role_id, assigned_by) ON public.user_roles TO sgv_app;

-- El estado (activo/revocado) de un dispositivo solo cambia con app.revoke_device().
GRANT SELECT ON public.devices TO sgv_app;
GRANT INSERT (id, organization_id, user_id, label, platform) ON public.devices TO sgv_app;
GRANT UPDATE (label, last_seen_at, last_pulled_seq, pending_ops_count) ON public.devices TO sgv_app;

GRANT SELECT ON public.sessions TO sgv_app;
GRANT INSERT (id, organization_id, user_id, device_id, token_hash, expires_at, rotated_from) ON public.sessions TO sgv_app;
GRANT UPDATE (revoked_at, last_used_at) ON public.sessions TO sgv_app;

-- audit_log: solo lectura. Se escribe únicamente a través de las funciones DEFINER.
GRANT SELECT ON public.audit_log TO sgv_app;

REVOKE ALL ON FUNCTION
  app.touch_updated_at(), app.permission_scope(text, text), app.has_permission(text, text),
  app.audit_insert(uuid, text, uuid, text, text[], jsonb, jsonb, uuid, uuid, jsonb),
  app.audit_trigger(), app.audit_immutable(), app.verify_audit_chain(uuid),
  app.log_event(uuid, uuid, uuid, text, text, uuid, jsonb),
  app.auth_find_user(text), app.auth_register_failure(uuid, integer, integer),
  app.auth_register_success(uuid), app.auth_find_session(uuid), app.auth_revoke_chain(uuid),
  app.revoke_device(uuid, text), app.role_permission_guard()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.permission_scope(text, text), app.has_permission(text, text),
  app.log_event(uuid, uuid, uuid, text, text, uuid, jsonb),
  app.auth_find_user(text), app.auth_register_failure(uuid, integer, integer),
  app.auth_register_success(uuid), app.auth_find_session(uuid), app.auth_revoke_chain(uuid),
  app.revoke_device(uuid, text)
TO sgv_app;
GRANT EXECUTE ON FUNCTION app.permission_scope(text, text), app.has_permission(text, text) TO sgv_worker;
