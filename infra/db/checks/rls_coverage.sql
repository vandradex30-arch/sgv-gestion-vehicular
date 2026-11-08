-- Falla (y por tanto la CI) si hay tablas sin RLS forzado o con DELETE para la app.
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
END $$;
\echo 'OK: todas las tablas tienen RLS forzado y ninguna permite DELETE a la aplicación'
