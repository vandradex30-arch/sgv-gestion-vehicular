-- Falla (y por tanto la CI) si se rompe alguna garantía estructural de seguridad.
DO $$
DECLARE
  sin_rls text;
  con_delete text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO sin_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname NOT IN ('schema_migrations')
    AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF sin_rls IS NOT NULL THEN
    RAISE EXCEPTION 'Tablas sin RLS habilitado y forzado: %', sin_rls;
  END IF;

  SELECT string_agg(table_name, ', ') INTO con_delete
  FROM information_schema.role_table_grants
  WHERE grantee IN ('sgv_app', 'sgv_worker') AND privilege_type = 'DELETE'
    AND table_schema = 'public';
  IF con_delete IS NOT NULL THEN
    RAISE EXCEPTION 'Tablas con DELETE concedido a la aplicación (la eliminación debe ser lógica): %', con_delete;
  END IF;

  IF has_column_privilege('sgv_app', 'public.users', 'password_hash', 'SELECT') THEN
    RAISE EXCEPTION 'La aplicación puede leer users.password_hash';
  END IF;
  IF has_column_privilege('sgv_app', 'public.users', 'failed_attempts', 'SELECT')
     OR has_column_privilege('sgv_app', 'public.users', 'locked_until', 'SELECT') THEN
    RAISE EXCEPTION 'La aplicación puede leer los contadores de bloqueo de users';
  END IF;
  IF has_table_privilege('sgv_app', 'public.audit_log', 'INSERT')
     OR has_table_privilege('sgv_app', 'public.audit_log', 'UPDATE')
     OR has_table_privilege('sgv_app', 'public.audit_log', 'DELETE')
     OR has_table_privilege('sgv_app', 'public.audit_log', 'TRUNCATE') THEN
    RAISE EXCEPTION 'La aplicación puede modificar audit_log directamente';
  END IF;
  IF has_column_privilege('sgv_app', 'public.devices', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'La aplicación puede cambiar devices.status sin pasar por app.revoke_device()';
  END IF;
END $$;
\echo 'OK: RLS forzado en todas las tablas, sin DELETE, y secretos/auditoría protegidos'
