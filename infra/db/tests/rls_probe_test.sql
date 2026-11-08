-- Prueba de aislamiento por organización. Ejecutar como superusuario (docker/CI).
BEGIN;

INSERT INTO public.rls_probe (organization_id, owner_id, note) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'prueba-a'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', 'prueba-b');

SET LOCAL ROLE sgv_app;

-- 1. Sin contexto no se ve ninguna fila
DO $$ BEGIN
  IF (SELECT count(*) FROM public.rls_probe) <> 0 THEN
    RAISE EXCEPTION 'FALLO: sin contexto no debe verse ninguna fila';
  END IF;
END $$;

-- 2. Con contexto de la organización A solo se ve lo de A
SELECT app.set_context('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', NULL);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.rls_probe) <> 1
     OR (SELECT count(*) FROM public.rls_probe WHERE note = 'prueba-a') <> 1 THEN
    RAISE EXCEPTION 'FALLO: la organización A debe ver solo su fila';
  END IF;
END $$;

-- 3. No se puede insertar en otra organización
DO $$ BEGIN
  BEGIN
    INSERT INTO public.rls_probe (organization_id, owner_id, note)
    VALUES ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'intruso');
    RAISE EXCEPTION 'FALLO: se permitió insertar en otra organización';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 4. No se puede modificar lo de otra organización (no la ve: 0 filas afectadas)
DO $$ DECLARE n int; BEGIN
  UPDATE public.rls_probe SET note = 'hackeado' WHERE note = 'prueba-b';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLO: se modificó una fila de otra organización'; END IF;
END $$;

-- 5. No se puede borrar
DO $$ BEGIN
  BEGIN
    DELETE FROM public.rls_probe;
    RAISE EXCEPTION 'FALLO: la aplicación pudo borrar filas';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- 6. Cambiar el contexto dentro de la transacción cambia lo que se ve
SELECT app.set_context('22222222-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', NULL);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.rls_probe WHERE note = 'prueba-b') <> 1
     OR (SELECT count(*) FROM public.rls_probe) <> 1 THEN
    RAISE EXCEPTION 'FALLO: la organización B debe ver solo su fila';
  END IF;
END $$;

RESET ROLE;
ROLLBACK;
\echo 'OK: pruebas de aislamiento RLS superadas'
