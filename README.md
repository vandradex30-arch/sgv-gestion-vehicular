# SGV – Sistema Integral de Gestión Vehicular

Estado: **Etapa 1 (identidad, permisos y auditoría)** sobre la Etapa 0 (fundaciones). El diseño completo está en el documento «SGV – Arquitectura técnica v2 (aprobada)».

## Estructura

```
apps/api               API NestJS: sesiones, permisos, usuarios, dispositivos, auditoría
packages/shared-types  Vocabulario común: roles, recursos, acciones, estados de flujo y de sync
packages/sync-protocol Contrato push/pull (se implementa en la Etapa 2)
infra/db               Roles, migraciones SQL, verificaciones y pruebas SQL
.github/workflows      CI: migra, verifica, prueba y compila
```

## Qué hay en la Etapa 1

**Base de datos (migraciones 0002 y 0003)**
- Tablas: `organizations`, `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `devices`, `sessions`, `audit_log`; todas con RLS forzado.
- Los siete perfiles y su matriz (70 permisos, 239 asignaciones), generados desde la matriz aprobada. Un trigger impide dar escritura al Auditor y permisos de administración a cualquiera que no sea el Administrador general.
- La aplicación nunca puede leer `password_hash` ni los contadores de bloqueo (privilegios por columna), ni cambiar el estado de un dispositivo salvo con `app.revoke_device()`.
- Auditoría: `audit_log` es de solo inserción (triggers que lo impiden, sin permisos de escritura para la aplicación) y cada fila lleva un hash que la encadena con la anterior; `app.verify_audit_chain()` detecta cualquier alteración. Los secretos (`password_hash`, `token_hash`) nunca se guardan en ella.

**API**
- `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /me`.
- Contraseñas con argon2id, bloqueo temporal tras 5 intentos fallidos, mismo error para correo inexistente y clave incorrecta.
- Token de acceso de 15 minutos. El refresh token rota en cada uso; reutilizar uno ya usado invalida todas las sesiones de ese dispositivo.
- Cada petición protegida verifica, dentro de su transacción, que sesión, dispositivo y usuario sigan vigentes, y luego el permiso `recurso:acción`. Revocar un dispositivo o desactivar un usuario surte efecto de inmediato.
- `POST/GET /users`, `PATCH /users/:id/status`, `GET /devices`, `POST /devices/:id/revoke`, `GET /audit`.
- El cliente genera un `deviceId` distinto por usuario en cada instalación (coincide con la base local por usuario del diseño).

## Puesta en marcha local

1. `cp .env.example .env` y cambiar las contraseñas y `JWT_SECRET`.
2. `docker compose --env-file .env up -d db` (crea los roles `sgv_app` y `sgv_worker`).
3. `set -a; source .env; set +a` y `pnpm install`.
4. `pnpm db:migrate`, `pnpm db:check`, `pnpm db:test`.
5. `pnpm --filter @sgv/api test` (las pruebas de integración).
6. Primer administrador (contraseña de 12 o más caracteres):
   `pnpm --filter @sgv/api build` y luego
   `ADMIN_EMAIL=tu@correo.cl ADMIN_PASSWORD='...' ORG_NAME='Mi organización' pnpm --filter @sgv/api create-admin`

## Límites conocidos y decisiones pendientes

- Las funciones `SECURITY DEFINER` pertenecen al rol de migraciones. En desarrollo y CI es superusuario; en producción debe ser un rol dedicado con `BYPASSRLS` (sin él, `FORCE ROW LEVEL SECURITY` las bloquearía).
- El encadenamiento del hash de auditoría toma un candado por organización hasta el fin de la transacción: correcto y simple para decenas de usuarios; con mucha concurrencia de escritura se calculará en segundo plano.
- Logística tiene `audit:read` con alcance "asignado" (su alcance); hasta resolver ese alcance en etapas posteriores no ve nada del historial.
- Alcances `assigned` (por ejemplo "su área" en informes) se definen en la matriz, pero se aplican cuando existan vehículos y generadores (Etapas 3 y 5).
- Cambiar los permisos de un rol y reasignar o quitar roles desde la API quedan para más adelante; hoy el rol se asigna al crear el usuario y los permisos se cambian con migraciones.
- Sin autenticación en dos pasos todavía (la columna existe). Sin límite de peticiones por IP más allá del bloqueo por cuenta; se agrega con el endurecimiento (Etapa 7).
- Una renovación concurrente del mismo refresh token (por ejemplo dos pestañas a la vez) se trata como reutilización y cierra las sesiones de ese dispositivo; el motor de sincronización usará un único ejecutor para evitarlo.
- Las versiones de dependencias son rangos iniciales: revisarlas al instalar.
