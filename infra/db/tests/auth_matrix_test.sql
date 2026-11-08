-- Pruebas de la matriz de perfiles, aislamiento entre organizaciones y auditoría.
-- Ejecutar como superusuario (docker/CI). Todo se deshace al final.
BEGIN;

-- 1. Siete perfiles de sistema
DO $$ BEGIN
  IF (SELECT count(*) FROM public.roles WHERE is_system) <> 7 THEN
    RAISE EXCEPTION 'FALLO: deben existir 7 roles de sistema';
  END IF;
END $$;

-- 2. El Auditor no tiene ningún permiso de escritura
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.role_permissions rp
             JOIN public.roles r ON r.id = rp.role_id
             JOIN public.permissions p ON p.id = rp.permission_id
             WHERE r.code = 'auditor' AND p.action NOT IN ('read', 'export')) THEN
    RAISE EXCEPTION 'FALLO: el auditor tiene permisos de escritura';
  END IF;
END $$;

-- 3. El Conductor u operador no valida, aprueba, autoriza ni administra
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.role_permissions rp
             JOIN public.roles r ON r.id = rp.role_id
             JOIN public.permissions p ON p.id = rp.permission_id
             WHERE r.code = 'conductor_operador'
               AND p.action IN ('validate', 'approve', 'authorize', 'manage')) THEN
    RAISE EXCEPTION 'FALLO: el conductor tiene permisos de validación, aprobación o administración';
  END IF;
END $$;

-- 4. Solo el Administrador general administra usuarios, dispositivos y respaldos
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.role_permissions rp
             JOIN public.roles r ON r.id = rp.role_id
             JOIN public.permissions p ON p.id = rp.permission_id
             WHERE p.action = 'manage' AND r.code <> 'admin_general') THEN
    RAISE EXCEPTION 'FALLO: otro perfil tiene permisos de administración';
  END IF;
END $$;

-- 5. El guard impide dar escritura al Auditor
DO $$ BEGIN
  BEGIN
    INSERT INTO public.role_permissions (role_id, permission_id, scope)
    SELECT r.id, p.id, 'all' FROM public.roles r, public.permissions p
     WHERE r.code = 'auditor' AND p.resource = 'vehicle' AND p.action = 'create';
    RAISE EXCEPTION 'FALLO: se permitió dar escritura al auditor';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FALLO%' THEN RAISE; END IF;
  END;
END $$;

-- Datos de prueba (como superusuario)
INSERT INTO public.organizations (id, name) VALUES
  ('aaaaaaaa-1111-0000-0000-000000000001', 'Org A'),
  ('bbbbbbbb-1111-0000-0000-000000000002', 'Org B');
INSERT INTO public.users (id, organization_id, email, full_name, password_hash) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-1111-0000-0000-000000000001', 'adm@a.test',  'Admin A',    'x'),
  ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-1111-0000-0000-000000000001', 'veh@a.test',  'Vehículos A','x'),
  ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-1111-0000-0000-000000000001', 'con@a.test',  'Conductor A','x'),
  ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-1111-0000-0000-000000000002', 'adm@b.test',  'Admin B',    'x');
INSERT INTO public.user_roles (organization_id, user_id, role_id)
SELECT v.org::uuid, v.usr::uuid, r.id FROM (VALUES
  ('aaaaaaaa-1111-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'admin_general'),
  ('aaaaaaaa-1111-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'vehiculos'),
  ('aaaaaaaa-1111-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000003', 'conductor_operador'),
  ('bbbbbbbb-1111-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 'admin_general')
) AS v(org, usr, code) JOIN public.roles r ON r.code = v.code;

-- 6. Auditoría: los inserts anteriores generaron entradas y la cadena está íntegra
DO $$ BEGIN
  IF (SELECT count(*) FROM public.audit_log WHERE organization_id = 'aaaaaaaa-1111-0000-0000-000000000001') < 7 THEN
    RAISE EXCEPTION 'FALLO: los triggers no registraron la auditoría esperada';
  END IF;
  IF app.verify_audit_chain('aaaaaaaa-1111-0000-0000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO: la cadena de auditoría debería estar íntegra';
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_log
             WHERE new_data ? 'password_hash' OR old_data ? 'password_hash') THEN
    RAISE EXCEPTION 'FALLO: la auditoría guardó un password_hash';
  END IF;
END $$;

-- 7. audit_log no se puede modificar ni siquiera como superusuario (trigger)
DO $$ BEGIN
  BEGIN
    UPDATE public.audit_log SET action = 'HACKEADO';
    RAISE EXCEPTION 'FALLO: se pudo modificar audit_log';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FALLO%' THEN RAISE; END IF;
  END;
END $$;

-- Desde aquí actúa la aplicación
SET LOCAL ROLE sgv_app;

-- 8. La aplicación no puede leer password_hash
DO $$ BEGIN
  BEGIN
    PERFORM password_hash FROM public.users;
    RAISE EXCEPTION 'FALLO: la aplicación pudo leer password_hash';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 9. La aplicación no puede escribir en audit_log
DO $$ BEGIN
  BEGIN
    INSERT INTO public.audit_log (organization_id, occurred_at, entity_type, action, row_hash)
    VALUES ('aaaaaaaa-1111-0000-0000-000000000001', now(), 'x', 'FALSO', 'x');
    RAISE EXCEPTION 'FALLO: la aplicación pudo escribir en audit_log';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 10. Alcances efectivos del Encargado de vehículos
SELECT app.set_context('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-1111-0000-0000-000000000001', NULL);
DO $$ BEGIN
  IF app.permission_scope('vehicle', 'create') IS DISTINCT FROM 'all' THEN
    RAISE EXCEPTION 'FALLO: vehículos debe poder crear vehículos';
  END IF;
  IF app.permission_scope('vehicle', 'approve') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO: vehículos no debe aprobar bajas';
  END IF;
  IF app.permission_scope('user', 'manage') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO: vehículos no debe administrar usuarios';
  END IF;
  -- sin user:manage solo ve su propio usuario
  IF (SELECT count(*) FROM public.users) <> 1 THEN
    RAISE EXCEPTION 'FALLO: vehículos debe ver solo su propio usuario';
  END IF;
  -- sin audit:read total no ve auditoría
  IF (SELECT count(*) FROM public.audit_log) <> 0 THEN
    RAISE EXCEPTION 'FALLO: vehículos no debe ver la auditoría';
  END IF;
END $$;

-- 11. Alcances del Conductor
SELECT app.set_context('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-1111-0000-0000-000000000001', NULL);
DO $$ BEGIN
  IF app.permission_scope('movement', 'create') IS DISTINCT FROM 'own' THEN
    RAISE EXCEPTION 'FALLO: el conductor debe crear solo movimientos propios';
  END IF;
  IF app.permission_scope('movement', 'approve') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO: el conductor no debe aprobar';
  END IF;
END $$;

-- 12. El Administrador de la organización A ve a sus 3 usuarios y la auditoría, pero no a los de B
SELECT app.set_context('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-1111-0000-0000-000000000001', NULL);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.users) <> 3 THEN
    RAISE EXCEPTION 'FALLO: el administrador A debe ver exactamente 3 usuarios';
  END IF;
  IF (SELECT count(*) FROM public.audit_log) = 0 THEN
    RAISE EXCEPTION 'FALLO: el administrador A debe ver la auditoría de su organización';
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_log WHERE organization_id <> 'aaaaaaaa-1111-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FALLO: el administrador A ve auditoría de otra organización';
  END IF;
  IF (SELECT count(*) FROM public.organizations) <> 1 THEN
    RAISE EXCEPTION 'FALLO: solo debe verse la propia organización';
  END IF;
END $$;

-- 13. No se puede cambiar el estado de un dispositivo sin app.revoke_device()
DO $$ BEGIN
  BEGIN
    UPDATE public.devices SET status = 'activo';
    RAISE EXCEPTION 'FALLO: la aplicación pudo cambiar devices.status';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

RESET ROLE;

-- 14. Detección de manipulación: alterar una fila (saltando el trigger) rompe la cadena
SET LOCAL session_replication_role = replica;
UPDATE public.audit_log SET entity_type = 'manipulado'
 WHERE id = (SELECT min(id) FROM public.audit_log WHERE organization_id = 'aaaaaaaa-1111-0000-0000-000000000001');
SET LOCAL session_replication_role = origin;
DO $$ BEGIN
  IF app.verify_audit_chain('aaaaaaaa-1111-0000-0000-000000000001') IS NULL THEN
    RAISE EXCEPTION 'FALLO: la manipulación del historial no fue detectada';
  END IF;
END $$;

ROLLBACK;
\echo 'OK: pruebas de matriz, aislamiento y auditoría superadas'
