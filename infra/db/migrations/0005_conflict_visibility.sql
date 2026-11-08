-- 0005: corrige la visibilidad de los conflictos de sincronización.
-- Antes, cualquier alcance sobre conflict:resolve (incluido "own") permitía ver los conflictos de otros usuarios.
-- Ahora solo el alcance total ve y modifica conflictos ajenos; los demás ven únicamente los propios.
DROP POLICY sync_conflicts_select ON public.sync_conflicts;
DROP POLICY sync_conflicts_update ON public.sync_conflicts;

CREATE POLICY sync_conflicts_select ON public.sync_conflicts FOR SELECT TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (user_id = (SELECT app.user_id())
              OR (SELECT app.permission_scope('conflict', 'resolve')) = 'all'));

CREATE POLICY sync_conflicts_update ON public.sync_conflicts FOR UPDATE TO sgv_app
  USING (organization_id = (SELECT app.organization_id())
         AND (user_id = (SELECT app.user_id())
              OR (SELECT app.permission_scope('conflict', 'resolve')) = 'all'))
  WITH CHECK (organization_id = (SELECT app.organization_id()));
