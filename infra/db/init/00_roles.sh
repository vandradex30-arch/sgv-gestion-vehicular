#!/bin/bash
set -euo pipefail
psql -v ON_ERROR_STOP=1 \
  -v app_password="$SGV_APP_PASSWORD" \
  -v worker_password="$SGV_WORKER_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /sgv/roles.sql
