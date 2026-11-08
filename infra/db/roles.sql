-- Roles de la aplicación. Variables psql: app_password, worker_password
-- Ninguno es superusuario ni tiene BYPASSRLS: las políticas RLS siempre los alcanzan.
CREATE ROLE sgv_app    LOGIN PASSWORD :'app_password'    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE sgv_worker LOGIN PASSWORD :'worker_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
