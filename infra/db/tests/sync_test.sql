-- Pruebas de las garantías de la sincronización en la base de datos. Ejecutar como superusuario.
BEGIN;

INSERT INTO public.organizations (id, name) VALUES
  ('aaaaaaaa-2222-0000-0000-000000000001', 'Org A'),
  ('bbbbbbbb-2222-0000-0000-000000000002', 'Org B');
INSERT INTO public.users (id, organization_id, email, full_name, password_hash) VALUES
  ('a2000000-0000-0000-0000-000000000001', 'aaaaaaaa-2222-0000-0000-000000000001', 'adm@sync.test', 'Admin', 'x'),
  ('a2000000-0000-0000-0000-000000000002', 'aaaaaaaa-2222-0000-0000-000000000001', 'veh@sync.test', 'Vehículos', 'x');
INSERT INTO public.user_roles (organization_id, user_id, role_id)
SELECT 'aaaaaaaa-2222-0000-0000-000000000001'::uuid, v.usr::uuid, r.id
  FROM (VALUES ('a2000000-0000-0000-0000-000000000001', 'admin_general'),
               ('a2000000-0000-0000-0000-000000000002', 'vehiculos')) AS v(usr, code)
  JOIN public.roles r ON r.code = v.code;

INSERT INTO public.vehicles (id, organization_id, plate) VALUES
  ('c0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-2222-0000-0000-000000000001', 'AAAA11'),
  ('c0000000-0000-0000-0000-00000000000b', 'aaaaaaaa-2222-0000-0000-000000000001', 'BBBB22'),
  ('c0000000-0000-0000-0000-00000000000c', 'bbbbbbbb-2222-0000-0000-000000000002', 'AAAA11');

-- 1. Secuencia por organización, independiente entre organizaciones
DO $$ BEGIN
  IF (SELECT server_seq FROM public.vehicles WHERE id = 'c0000000-0000-0000-0000-00000000000a') <> 1
     OR (SELECT server_seq FROM public.vehicles WHERE id = 'c0000000-0000-0000-0000-00000000000b') <> 2
     OR (SELECT server_seq FROM public.vehicles WHERE id = 'c0000000-0000-0000-0000-00000000000c') <> 1 THEN
    RAISE EXCEPTION 'FALLO: la secuencia debe ser 1,2 en la organización A y 1 en la B';
  END IF;
END $$;

-- 2. La misma patente se permite en otra organización pero no dos veces en la misma
DO $$ BEGIN
  BEGIN
    INSERT INTO public.vehicles (id, organization_id, plate)
    VALUES ('c0000000-0000-0000-0000-0000000000dd', 'aaaaaaaa-2222-0000-0000-000000000001', 'AAAA11');
    RAISE EXCEPTION 'FALLO: se permitió una patente repetida en la misma organización';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- 3. Versión, fechas y secuencia las fija la base, aunque el cliente intente falsearlas
INSERT INTO public.vehicles (id, organization_id, plate, version, server_seq, created_at)
VALUES ('c0000000-0000-0000-0000-00000000000d', 'aaaaaaaa-2222-0000-0000-000000000001', 'DDDD44', 99, 9999, '2001-01-01');
DO $$ BEGIN
  IF (SELECT version FROM public.vehicles WHERE id = 'c0000000-0000-0000-0000-00000000000d') <> 1
     OR (SELECT server_seq FROM public.vehicles WHERE id = 'c0000000-0000-0000-0000-00000000000d') <> 3
     OR (SELECT created_at FROM public.vehicles WHERE id = 'c0000000-0000-0000-0000-00000000000d') < now() - interval '1 day' THEN
    RAISE EXCEPTION 'FALLO: el cliente pudo falsear versión, secuencia o fecha de creación';
  END IF;
END $$;

-- 4. Cada modificación sube la versión y toma una secuencia nueva
UPDATE public.vehicles SET brand = 'Toyota' WHERE id = 'c0000000-0000-0000-0000-00000000000a';
DO $$ BEGIN
  IF (SELECT version FROM public.vehicles WHERE id = 'c0000000-0000-0000-0000-00000000000a') <> 2
     OR (SELECT server_seq FROM public.vehicles WHERE id = 'c0000000-0000-0000-0000-00000000000a') <> 4 THEN
    RAISE EXCEPTION 'FALLO: la modificación debe dar versión 2 y secuencia 4';
  END IF;
END $$;

-- 5. Campos inmutables
DO $$ BEGIN
  BEGIN
    UPDATE public.vehicles SET organization_id = 'bbbbbbbb-2222-0000-0000-000000000002'
     WHERE id = 'c0000000-0000-0000-0000-00000000000a';
    RAISE EXCEPTION 'FALLO: se pudo cambiar la organización de un registro';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 6. Un registro eliminado no se modifica ni se restaura, y su patente queda libre
UPDATE public.vehicles SET deleted_at = now(), delete_reason = 'prueba'
 WHERE id = 'c0000000-0000-0000-0000-00000000000b';
DO $$ BEGIN
  BEGIN
    UPDATE public.vehicles SET brand = 'X' WHERE id = 'c0000000-0000-0000-0000-00000000000b';
    RAISE EXCEPTION 'FALLO: se modificó un registro eliminado';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.vehicles SET deleted_at = NULL WHERE id = 'c0000000-0000-0000-0000-00000000000b';
    RAISE EXCEPTION 'FALLO: se restauró un registro eliminado';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
INSERT INTO public.vehicles (id, organization_id, plate)
VALUES ('c0000000-0000-0000-0000-00000000000e', 'aaaaaaaa-2222-0000-0000-000000000001', 'BBBB22');

-- 7. Historial: los cambios de negocio posteriores a una versión
SET LOCAL ROLE sgv_app;
SELECT app.set_context('a2000000-0000-0000-0000-000000000002', 'aaaaaaaa-2222-0000-0000-000000000001', NULL);

DO $$ BEGIN
  IF (SELECT count(*) FROM public.vehicles WHERE organization_id = 'bbbbbbbb-2222-0000-0000-000000000002') <> 0 THEN
    RAISE EXCEPTION 'FALLO: se ve un vehículo de otra organización';
  END IF;
END $$;

UPDATE public.vehicles SET model = 'Yaris' WHERE id = 'c0000000-0000-0000-0000-00000000000a';
DO $$ BEGIN
  IF app.fields_changed_since('vehicles', 'c0000000-0000-0000-0000-00000000000a', 1) IS DISTINCT FROM ARRAY['brand', 'model'] THEN
    RAISE EXCEPTION 'FALLO: los cambios desde la versión 1 deben ser brand y model';
  END IF;
  IF app.fields_changed_since('vehicles', 'c0000000-0000-0000-0000-00000000000a', 2) IS DISTINCT FROM ARRAY['model'] THEN
    RAISE EXCEPTION 'FALLO: los cambios desde la versión 2 deben ser solo model';
  END IF;
END $$;

-- 8. El Encargado de vehículos edita pero no da de baja
DO $$ BEGIN
  BEGIN
    UPDATE public.vehicles SET deleted_at = now() WHERE id = 'c0000000-0000-0000-0000-00000000000a';
    RAISE EXCEPTION 'FALLO: vehículos pudo dar de baja un vehículo';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 9. El Administrador sí da de baja, y queda registrado quién
SELECT app.set_context('a2000000-0000-0000-0000-000000000001', 'aaaaaaaa-2222-0000-0000-000000000001', NULL);
UPDATE public.vehicles SET deleted_at = now() WHERE id = 'c0000000-0000-0000-0000-00000000000a';
DO $$ BEGIN
  IF (SELECT deleted_by FROM public.vehicles WHERE id = 'c0000000-0000-0000-0000-00000000000a')
     IS DISTINCT FROM 'a2000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FALLO: la baja debe registrar al administrador';
  END IF;
END $$;

-- 10. La aplicación no puede tocar el contador de secuencias
DO $$ BEGIN
  BEGIN
    PERFORM * FROM public.sync_counters;
    RAISE EXCEPTION 'FALLO: la aplicación pudo leer sync_counters';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 11. Conflictos: con alcance "own" solo se ven los propios; con alcance total, todos
RESET ROLE;
INSERT INTO public.users (id, organization_id, email, full_name, password_hash)
VALUES ('a2000000-0000-0000-0000-000000000003', 'aaaaaaaa-2222-0000-0000-000000000001', 'con@sync.test', 'Conductor', 'x');
INSERT INTO public.user_roles (organization_id, user_id, role_id)
SELECT 'aaaaaaaa-2222-0000-0000-000000000001'::uuid, 'a2000000-0000-0000-0000-000000000003'::uuid, id
  FROM public.roles WHERE code = 'conductor_operador';
INSERT INTO public.devices (id, organization_id, user_id, label, platform) VALUES
  ('d2000000-0000-0000-0000-000000000001', 'aaaaaaaa-2222-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'PC', 'web'),
  ('d2000000-0000-0000-0000-000000000003', 'aaaaaaaa-2222-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000003', 'Celular', 'web');
INSERT INTO public.sync_conflicts (organization_id, entity_type, entity_id, conflict_type, operation_id, kind, device_id, user_id, client_patch) VALUES
  ('aaaaaaaa-2222-0000-0000-000000000001', 'vehicle', 'c0000000-0000-0000-0000-0000000000f1', 'permiso',
   'e0000000-0000-0000-0000-000000000001', 'create', 'd2000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', '{}'),
  ('aaaaaaaa-2222-0000-0000-000000000001', 'vehicle', 'c0000000-0000-0000-0000-0000000000f2', 'permiso',
   'e0000000-0000-0000-0000-000000000002', 'create', 'd2000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-000000000003', '{}');
SET LOCAL ROLE sgv_app;
SELECT app.set_context('a2000000-0000-0000-0000-000000000003', 'aaaaaaaa-2222-0000-0000-000000000001', NULL);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.sync_conflicts) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.sync_conflicts WHERE user_id = 'a2000000-0000-0000-0000-000000000003') THEN
    RAISE EXCEPTION 'FALLO: el conductor debe ver solo su propio conflicto';
  END IF;
END $$;
SELECT app.set_context('a2000000-0000-0000-0000-000000000001', 'aaaaaaaa-2222-0000-0000-000000000001', NULL);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.sync_conflicts) <> 2 THEN
    RAISE EXCEPTION 'FALLO: el administrador debe ver todos los conflictos de su organización';
  END IF;
END $$;

RESET ROLE;
ROLLBACK;
\echo 'OK: pruebas de sincronización en la base de datos superadas'
