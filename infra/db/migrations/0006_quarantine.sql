-- 0006: cuarentena de operaciones recuperadas de dispositivos revocados (Etapa 2c)
-- Un administrador importa el paquete de recuperación; las operaciones quedan guardadas para revisión.
-- Nunca se aplican automáticamente: se decide caso a caso.
CREATE TABLE public.sync_quarantine (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id),
  uploaded_by      uuid NOT NULL REFERENCES public.users(id),
  source_user_id   uuid NOT NULL REFERENCES public.users(id),
  source_device_id uuid NOT NULL REFERENCES public.devices(id),
  bundle_hash      text NOT NULL,
  op_count         integer NOT NULL CHECK (op_count BETWEEN 1 AND 500),
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aceptada', 'descartada')),
  note             text CHECK (note IS NULL OR char_length(note) <= 500),
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_by      uuid REFERENCES public.users(id),
  reviewed_at      timestamptz
);
-- El mismo paquete no se puede importar dos veces.
CREATE UNIQUE INDEX sync_quarantine_hash_uq ON public.sync_quarantine (organization_id, bundle_hash);
CREATE INDEX sync_quarantine_status_idx ON public.sync_quarantine (organization_id, status);

ALTER TABLE public.sync_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_quarantine FORCE ROW LEVEL SECURITY;

CREATE POLICY sync_quarantine_select ON public.sync_quarantine FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (SELECT app.permission_scope('device', 'manage')) = 'all');
CREATE POLICY sync_quarantine_insert ON public.sync_quarantine FOR INSERT TO sgv_app
  WITH CHECK (organization_id = (SELECT app.organization_id())
              AND uploaded_by = (SELECT app.user_id())
              AND (SELECT app.permission_scope('device', 'manage')) = 'all');
CREATE POLICY sync_quarantine_update ON public.sync_quarantine FOR UPDATE TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (SELECT app.permission_scope('device', 'manage')) = 'all')
  WITH CHECK (organization_id = (SELECT app.organization_id()));

GRANT SELECT, INSERT ON public.sync_quarantine TO sgv_app;
GRANT UPDATE (status, note, reviewed_by, reviewed_at) ON public.sync_quarantine TO sgv_app;
