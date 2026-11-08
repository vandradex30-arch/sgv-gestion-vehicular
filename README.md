# SGV – Sistema Integral de Gestión Vehicular

Estado: **Etapa 0 (fundaciones)**. El diseño completo está en el documento «SGV – Arquitectura técnica v2 (aprobada)».

## Estructura

```
apps/api              API NestJS (Etapa 0: contexto de usuario + RLS, /health)
packages/shared-types Vocabulario común: roles, estados de flujo y de sync, columnas comunes
packages/sync-protocol Contrato push/pull (se implementa en la Etapa 2)
infra/db              Roles, migraciones SQL, verificación de RLS y pruebas SQL
.github/workflows     CI: migra, verifica RLS, prueba aislamiento y compila
```

## Puesta en marcha local

1. `cp .env.example .env` y cambiar las contraseñas.
2. `docker compose --env-file .env up -d db` (crea los roles `sgv_app` y `sgv_worker`).
3. `export $(grep -v '^#' .env | xargs)` y `pnpm install`.
4. `pnpm db:migrate`, luego `pnpm db:check` y `pnpm db:test`.
5. `ALLOW_DEV_ACTOR=true pnpm --filter @sgv/api test` para las pruebas de integración.

## Qué contiene la Etapa 0

- Roles de base de datos sin superusuario ni `BYPASSRLS` (`sgv_app`, `sgv_worker`).
- Funciones `app.user_id()`, `app.organization_id()`, `app.device_id()` y `app.set_context()` (contexto local a la transacción).
- Tabla `rls_probe` con `FORCE ROW LEVEL SECURITY` y el patrón de políticas que usarán las tablas reales.
- Verificación automática: toda tabla de `public` debe tener RLS forzado y la aplicación no puede tener `DELETE`.
- API: un interceptor abre una transacción por petición, fija el contexto y guarda la conexión en `nestjs-cls`; `TenantDb.query()` falla si no hay transacción activa.
- Seguridad por defecto: sin autenticación (Etapa 1) toda petición de negocio recibe 401. `ALLOW_DEV_ACTOR=true` habilita identidad por cabeceras solo para pruebas y la API no arranca así en producción.

## Pendiente de la Etapa 0

- Banco de pruebas de sincronización con dos dispositivos simulados: se construye en la Etapa 2, cuando existan los endpoints de push y pull que probar.
- Archivo `pnpm-lock.yaml`: se genera en la primera instalación y debe versionarse (luego la CI pasa a `--frozen-lockfile`).

## Límites conocidos

- Cualquier código con acceso SQL de `sgv_app` puede invocar `app.set_context`; la defensa son las consultas parametrizadas, la revisión de código y que los repositorios usen solo `TenantDb`.
- En desarrollo el rol de `docker-compose` es superusuario (solo para migraciones y pruebas). En producción el dueño de las tablas debe ser un rol sin superusuario.
- Las versiones de dependencias son rangos iniciales: revisarlas al instalar.
