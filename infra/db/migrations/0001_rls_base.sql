-- 0001: base de RLS (Etapa 0)
-- Requiere que existan los roles sgv_app y sgv_worker (infra/db/roles.sql).

CREATE SCHEMA IF NOT EXISTS app;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public, app TO sgv_app, sgv_worker;

-- Contexto de la petición. Se fija con set_config(..., true): vale solo dentro de la
-- transacción actual, así no se filtra entre usuarios que comparten conexión del pool.
CREATE OR REPLACE FUNCTION app.user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.organization_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.device_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.device_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.set_context(p_user uuid, p_org uuid, p_device uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id',         COALESCE(p_user::text,   ''), true);
  PERFORM set_config('app.organization_id', COALESCE(p_org::text,    ''), true);
  PERFORM set_config('app.device_id',       COALESCE(p_device::text, ''), true);
END $$;

GRANT EXECUTE ON FUNCTION app.user_id(), app.organization_id(), app.device_id(),
  app.set_context(uuid, uuid, uuid) TO sgv_app, sgv_worker;

-- Tabla de prueba que fija el patrón de políticas que usarán las tablas reales.
CREATE TABLE public.rls_probe (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  owner_id        uuid NOT NULL,
  note            text NOT NULL CHECK (char_length(note) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rls_probe_org_idx ON public.rls_probe (organization_id);

ALTER TABLE public.rls_probe ENABLE ROW LEVEL SECURITY;
-- FORCE: sin esto el dueño de la tabla ignoraría las políticas.
ALTER TABLE public.rls_probe FORCE ROW LEVEL SECURITY;

-- (SELECT app.x()) hace que se evalúe una sola vez por consulta.
CREATE POLICY rls_probe_select ON public.rls_probe FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id()));

CREATE POLICY rls_probe_insert ON public.rls_probe FOR INSERT TO sgv_app
  WITH CHECK (organization_id = (SELECT app.organization_id())
              AND owner_id = (SELECT app.user_id()));

CREATE POLICY rls_probe_update ON public.rls_probe FOR UPDATE TO sgv_app
  USING (organization_id = (SELECT app.organization_id()))
  WITH CHECK (organization_id = (SELECT app.organization_id()));

-- Sin DELETE: la eliminación del sistema es lógica.
GRANT SELECT, INSERT, UPDATE ON public.rls_probe TO sgv_app;
