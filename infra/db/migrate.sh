#!/usr/bin/env bash
# Aplica en orden las migraciones de infra/db/migrations con el rol dueño.
set -euo pipefail
: "${DATABASE_URL_OWNER:?definir DATABASE_URL_OWNER}"
psql "$DATABASE_URL_OWNER" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"
for f in $(ls infra/db/migrations/*.sql | sort); do
  name=$(basename "$f")
  applied=$(psql "$DATABASE_URL_OWNER" -tA -c "SELECT 1 FROM public.schema_migrations WHERE name = '${name}'")
  if [ -z "$applied" ]; then
    echo "Aplicando ${name}"
    psql "$DATABASE_URL_OWNER" -v ON_ERROR_STOP=1 -q -1 -f "$f" \
      -c "INSERT INTO public.schema_migrations (name) VALUES ('${name}')"
  else
    echo "Ya aplicada: ${name}"
  fi
done
