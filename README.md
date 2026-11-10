# SGV – Sistema Integral de Gestión Vehicular

Estado: **Etapa 2c, primera parte (sesión, sincronización automática y recuperación)** sobre la Etapa 2b (motor del dispositivo), la Etapa 2a (servidor de sincronización), la Etapa 1 (identidad, permisos y auditoría) y la Etapa 0 (fundaciones). El diseño completo está en el documento «SGV – Arquitectura técnica v2 (aprobada)».

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

## Qué hay en la Etapa 2a (servidor de sincronización)

La Etapa 2 se entrega en tres partes, cada una verificada antes de seguir:
**2a** servidor de sincronización (esta), **2b** motor del dispositivo (IndexedDB cifrada, cola de salida, simulador de dos dispositivos) y **2c** pantallas, cierre de sesión seguro, cuarentena y recuperación.

- **Orden por secuencia del servidor:** cada cambio recibe un número por organización (`server_seq`), asignado por la base de datos bajo un candado que dura hasta confirmar la transacción. Así el orden coincide con el de confirmación y el pull nunca se salta cambios. Los relojes de los dispositivos no ordenan nada.
- **Columnas comunes a prueba de falsificación:** versión, fechas del servidor, usuario y dispositivo de origen y secuencia las fija un trigger. El cliente no puede enviarlas.
- **`POST /sync/push`** (hasta 50 operaciones): idempotente por `operationId`. Cada operación termina `aplicada`, `duplicada` (reintento), `conflicto` o `rechazada`; una operación fallida no afecta al resto del lote.
- **`POST /sync/pull`**: cambios desde un cursor, con paginación y eliminaciones lógicas.
- **Fusión por campo:** si dos dispositivos cambian campos distintos se combinan solos; si cambian el mismo campo crítico se abre un conflicto; en el texto libre (`notes`) gana el último cambio recibido.
- **Duplicados:** misma patente en el mismo vehículo nuevo = `duplicado_probable`, que solo se resuelve aceptando lo que ya existe.
- **Conflictos:** `GET /sync/conflicts` y `POST /sync/conflicts/:id/resolve` (servidor, cliente o manual). Cada resolución es un cambio normal, auditado.
- **Permisos:** cada operación se valida contra la matriz (crear, editar y dar de baja = `vehicle:create`, `vehicle:update` y `vehicle:approve`); sin permiso queda como conflicto de tipo `permiso`, conservando el cambio.
- **Entidad piloto:** `vehicles` (patente, marca, modelo, año, notas). La Etapa 3 la amplía; el motor es genérico y se alimenta de `src/sync/entity-registry.ts`.

Pendiente de la Etapa 2c: cuarentena de operaciones de dispositivos revocados y paquete de recuperación.
Pendiente de las Etapas 3 a 5: alcances `assigned` y `own` en lectura (hoy el conductor no recibe vehículos porque aún no hay asignaciones).

## Qué hay en la Etapa 2b (motor del dispositivo): `packages/sync-client`

Biblioteca sin interfaz gráfica, pensada para que la Etapa 2c solo agregue pantallas encima.

- **Base local cifrada (IndexedDB + Dexie):** una base por usuario y organización. Solo los campos de índice (tipo, id, estado) están en claro; todo el contenido va cifrado con AES-GCM de 256 bits, ligado a su registro (copiar el contenido de un registro a otro se detecta).
- **Claves:** clave de datos aleatoria, protegida con una clave derivada de la contraseña o PIN (Argon2id en WebAssembly). Cambiar el PIN solo re-protege la clave. Tras 3 fallos hay esperas crecientes; tras 10 se exige iniciar sesión en línea; nunca se borran datos por intentos fallidos.
- **Cola de cambios:** cada guardado actualiza el registro y encola su operación en una sola transacción. Un doble toque en "Guardar" no duplica (mismo `operationId`); los cambios sucesivos antes de enviar se acumulan en uno; crear y eliminar antes de sincronizar no deja rastro.
- **Sincronización:** primero envía (un cambio por registro en cada ronda, en el orden del dispositivo) y después recibe. Ante corte de red, respuesta perdida o cierre de la app a mitad del envío, nada se pierde ni se duplica.
- **Conflictos:** el registro queda en estado `conflicto`, lo local no se pierde, los cambios siguientes sobre ese registro esperan y los de otros registros siguen. Se resuelve eligiendo servidor, cliente o manual.
- **Cierre de sesión seguro:** `safeWipe()` se niega mientras haya registros sin sincronizar.
- **Sesión:** `AuthClient` renueva el token con una sola renovación compartida y `HttpTransport` distingue sin conexión (se reintenta), sesión inválida (por ejemplo, dispositivo revocado) y errores de protocolo. Un dispositivo revocado pierde el acceso pero conserva sus registros pendientes.

Pruebas: las del motor corren sin servidor (`pnpm --filter @sgv/sync-client test`) y las de dos dispositivos reales contra el servidor y PostgreSQL están en `apps/api/test/two-devices.e2e-spec.ts`.

Pendiente de la Etapa 2c: pantallas, disparadores automáticos (reconexión, volver a primer plano, temporizador), bloqueo al cerrar sesión con pendientes, cuarentena y paquete de recuperación, y la unificación de los tipos del protocolo (hoy duplicados entre `sync-protocol` y `sync-client`).

## Qué hay en la Etapa 2c (primera parte: mecánica, sin pantallas)

- **`AutoSync`** (dispositivo): sincroniza al abrir, al volver la conexión, al volver a primer plano, poco después de guardar (agrupando guardados seguidos) y cada cierto tiempo. Sin conexión reintenta con esperas crecientes (5 s, 10 s, 20 s... hasta 5 min) y se recupera de inmediato cuando vuelve la red. En iOS no existe sincronización con la app cerrada: todo ocurre con ella abierta.
- **`SessionManager`** (dispositivo): coordina el ciclo de vida de la sesión con una regla central: **cerrar sesión o perder el acceso nunca borra registros sin confirmar**.
  - Cerrar sesión: sincroniza primero. Si todo se confirmó, borra los datos locales; si no, bloquea el equipo, conserva todo y lo informa.
  - Plazo máximo sin verificar en línea (7 días por defecto): pasado el plazo se exige reconectar, sin tocar los datos.
  - Bloqueo por inactividad.
  - Dispositivo revocado o usuario desactivado: cuarentena (todo conservado y bloqueado). El borrado solo se permite después de exportar un paquete de recuperación que incluya cada operación pendiente; si se agrega algo después de exportar, se exige exportar otra vez.
- **Paquete de recuperación:** las operaciones pendientes cifradas con la llave pública de la organización (RSA-OAEP + AES-GCM). El dispositivo guarda esa llave al iniciar sesión (`GET /sync/recovery-key`), así que puede exportar sin conexión. Solo el servidor, con la llave privada, lo abre.
- **Cuarentena en el servidor:** `POST /sync/quarantine/import`, `GET /sync/quarantine`, `POST /sync/quarantine/:id/review`. Solo quien administra dispositivos. Valida que el paquete sea de la misma organización y que el dispositivo corresponda al usuario, impide importar dos veces el mismo paquete y deja todo auditado. **Las operaciones no se aplican solas**: el administrador las revisa y marca como aceptada (registrada a mano) o descartada.
- **Llaves de la organización:** `pnpm --filter @sgv/api build` y luego `pnpm --filter @sgv/api create-recovery-keys` imprime `RECOVERY_PUBLIC_KEY` y `RECOVERY_PRIVATE_KEY`. La privada es secreta: va solo en la configuración del servidor y debe respaldarse aparte; sin ella los paquetes ya exportados no se pueden abrir.

Decisión pendiente (Etapa 7): si un día se quiere aplicar automáticamente lo recuperado, hay que decidir a nombre de quién queda (el administrador o el usuario original). Mientras tanto la revisión es manual.

Pendiente de la Etapa 2c (segunda parte): las pantallas.

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
