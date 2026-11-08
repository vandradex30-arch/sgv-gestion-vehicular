import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { createOrg, createUser, PASSWORD } from './helpers';

jest.setTimeout(60000);

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;
const suite = OWNER_URL && APP_URL ? describe : describe.skip;

suite('Sincronización del servidor: push, pull, duplicados y conflictos (PostgreSQL real)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let owner: Pool;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'prueba-jwt-secret-prueba-jwt-secret-0123456789';
    process.env.ALLOW_DEV_ACTOR = 'false';
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();
    owner = new Pool({ connectionString: OWNER_URL });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.end();
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const plate = () => `T${randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()}`;

  async function login(email: string, deviceId: string = randomUUID()): Promise<string> {
    const res = await request(http)
      .post('/auth/login')
      .send({ email, password: PASSWORD, deviceId, deviceLabel: 'Equipo de prueba', platform: 'web' })
      .expect(200);
    return res.body.accessToken as string;
  }

  let seq = 0;
  const op = (over: Record<string, unknown> = {}) => ({
    operationId: randomUUID(),
    entityType: 'vehicle',
    entityId: randomUUID(),
    kind: 'create',
    baseVersion: null,
    patch: { plate: plate() },
    clientUpdatedAt: new Date().toISOString(),
    deviceSeq: ++seq,
    ...over,
  });

  const push = (token: string, operations: unknown[]) =>
    request(http).post('/sync/push').set(bearer(token)).send({ operations });
  const pull = (token: string, sinceSeq = 0, limit?: number) =>
    request(http).post('/sync/pull').set(bearer(token)).send({ sinceSeq, limit });

  async function setup(roleCode = 'admin_general') {
    const org = await createOrg(owner, `Org sync ${randomUUID().slice(0, 6)}`);
    const user = await createUser(owner, org, roleCode);
    return { org, user };
  }

  it('crea un vehículo, lo recibe por pull y registra usuario y dispositivo de origen', async () => {
    const { user } = await setup();
    const deviceId = randomUUID();
    const token = await login(user.email, deviceId);
    const id = randomUUID();
    const p = plate();

    const res = await push(token, [op({ entityId: id, patch: { plate: p, brand: 'Toyota', year: 2020 } })]).expect(200);
    expect(res.body.results[0]).toMatchObject({ result: 'aplicada', version: 1, merged: false });

    const pulled = await pull(token).expect(200);
    expect(pulled.body.changes).toHaveLength(1);
    const change = pulled.body.changes[0];
    expect(change).toMatchObject({ entityType: 'vehicle', entityId: id, version: 1 });
    expect(change.record).toMatchObject({
      plate: p,
      brand: 'Toyota',
      year: 2020,
      createdBy: user.id,
      createdDeviceId: deviceId,
      deletedAt: null,
    });
    expect(pulled.body.nextSeq).toBe(change.serverSeq);
    expect(pulled.body.hasMore).toBe(false);
  });

  it('reenviar la misma operación no duplica nada (idempotencia)', async () => {
    const { user } = await setup();
    const token = await login(user.email);
    const create = op();
    const first = await push(token, [create]).expect(200);
    const second = await push(token, [create]).expect(200);
    expect(first.body.results[0].result).toBe('aplicada');
    expect(second.body.results[0]).toMatchObject({ result: 'duplicada', version: 1 });
    expect((await pull(token).expect(200)).body.changes).toHaveLength(1);
  });

  it('actualiza con la versión base correcta y sube la versión', async () => {
    const { user } = await setup();
    const token = await login(user.email);
    const id = randomUUID();
    await push(token, [op({ entityId: id })]).expect(200);
    const upd = await push(token, [
      op({ entityId: id, kind: 'update', baseVersion: 1, patch: { brand: 'Nissan', year: 2019 } }),
    ]).expect(200);
    expect(upd.body.results[0]).toMatchObject({ result: 'aplicada', version: 2, merged: false });
    const changes = (await pull(token).expect(200)).body.changes;
    expect(changes[0].record).toMatchObject({ brand: 'Nissan', year: 2019, version: 2 });
  });

  it('fusiona automáticamente cuando dos dispositivos cambian campos distintos', async () => {
    const { user } = await setup();
    const tokenA = await login(user.email);
    const tokenB = await login(user.email);
    const id = randomUUID();
    await push(tokenA, [op({ entityId: id })]).expect(200);

    await push(tokenA, [op({ entityId: id, kind: 'update', baseVersion: 1, patch: { brand: 'Toyota' } })]).expect(200);
    const b = await push(tokenB, [op({ entityId: id, kind: 'update', baseVersion: 1, patch: { model: 'Yaris' } })]).expect(200);
    expect(b.body.results[0]).toMatchObject({ result: 'aplicada', version: 3, merged: true });

    const record = (await pull(tokenA).expect(200)).body.changes[0].record;
    expect(record).toMatchObject({ brand: 'Toyota', model: 'Yaris', version: 3 });
  });

  it('abre un conflicto cuando dos dispositivos cambian el mismo campo crítico y permite resolverlo', async () => {
    const { user } = await setup();
    const tokenA = await login(user.email);
    const tokenB = await login(user.email);
    const id = randomUUID();
    await push(tokenA, [op({ entityId: id })]).expect(200);
    await push(tokenA, [op({ entityId: id, kind: 'update', baseVersion: 1, patch: { brand: 'Toyota' } })]).expect(200);

    const conflicting = op({ entityId: id, kind: 'update', baseVersion: 1, patch: { brand: 'Nissan' } });
    const res = await push(tokenB, [conflicting]).expect(200);
    expect(res.body.results[0]).toMatchObject({
      result: 'conflicto',
      conflictType: 'version',
      conflictingFields: ['brand'],
    });
    const conflictId = res.body.results[0].conflictId;

    // reintentar la misma operación devuelve el mismo conflicto
    const again = await push(tokenB, [conflicting]).expect(200);
    expect(again.body.results[0]).toMatchObject({ result: 'conflicto', conflictId });

    const list = await request(http).get('/sync/conflicts').set(bearer(tokenB)).expect(200);
    const found = list.body.find((c: { id: string }) => c.id === conflictId);
    expect(found).toMatchObject({ conflictType: 'version', kind: 'update' });
    expect(found.serverSnapshot.brand).toBe('Toyota');
    expect(found.clientPatch.brand).toBe('Nissan');

    // el servidor no cambió
    expect((await pull(tokenB).expect(200)).body.changes[0].record).toMatchObject({ brand: 'Toyota', version: 2 });

    const resolved = await request(http)
      .post(`/sync/conflicts/${conflictId}/resolve`)
      .set(bearer(tokenB))
      .send({ resolution: 'cliente' })
      .expect(200);
    expect(resolved.body.record).toMatchObject({ brand: 'Nissan', version: 3 });
    await request(http).post(`/sync/conflicts/${conflictId}/resolve`).set(bearer(tokenB)).send({ resolution: 'servidor' }).expect(409);
  });

  it('en el texto libre gana el último cambio recibido por el servidor', async () => {
    const { user } = await setup();
    const tokenA = await login(user.email);
    const tokenB = await login(user.email);
    const id = randomUUID();
    await push(tokenA, [op({ entityId: id })]).expect(200);
    await push(tokenA, [op({ entityId: id, kind: 'update', baseVersion: 1, patch: { notes: 'nota A' } })]).expect(200);
    const b = await push(tokenB, [op({ entityId: id, kind: 'update', baseVersion: 1, patch: { notes: 'nota B' } })]).expect(200);
    expect(b.body.results[0]).toMatchObject({ result: 'aplicada', merged: true });
    expect((await pull(tokenA).expect(200)).body.changes[0].record.notes).toBe('nota B');
  });

  it('detecta vehículos duplicados (misma patente) y exige decisión humana', async () => {
    const { user } = await setup();
    const token = await login(user.email);
    const p = plate();
    const firstId = randomUUID();
    await push(token, [op({ entityId: firstId, patch: { plate: p } })]).expect(200);

    const dup = await push(token, [op({ entityId: randomUUID(), patch: { plate: p.toLowerCase() } })]).expect(200);
    expect(dup.body.results[0]).toMatchObject({ result: 'conflicto', conflictType: 'duplicado_probable' });

    const list = await request(http).get('/sync/conflicts').set(bearer(token)).expect(200);
    expect(list.body[0].serverSnapshot.id).toBe(firstId);

    // un duplicado solo se resuelve aceptando lo que ya existe
    await request(http)
      .post(`/sync/conflicts/${dup.body.results[0].conflictId}/resolve`)
      .set(bearer(token))
      .send({ resolution: 'cliente' })
      .expect(400);
    await request(http)
      .post(`/sync/conflicts/${dup.body.results[0].conflictId}/resolve`)
      .set(bearer(token))
      .send({ resolution: 'servidor' })
      .expect(200);
    expect((await request(http).get('/sync/conflicts').set(bearer(token)).expect(200)).body).toHaveLength(0);
  });

  it('cambiar la patente a una ya usada se rechaza sin romper el resto del lote', async () => {
    const { user } = await setup();
    const token = await login(user.email);
    const p1 = plate();
    const id1 = randomUUID();
    const id2 = randomUUID();
    await push(token, [op({ entityId: id1, patch: { plate: p1 } }), op({ entityId: id2 })]).expect(200);
    const res = await push(token, [
      op({ entityId: id2, kind: 'update', baseVersion: 1, patch: { plate: p1 } }),
      op({ entityId: id2, kind: 'update', baseVersion: 1, patch: { brand: 'Kia' } }),
    ]).expect(200);
    expect(res.body.results[0]).toMatchObject({ result: 'rechazada', reason: 'conflicto_de_unicidad' });
    expect(res.body.results[1]).toMatchObject({ result: 'aplicada', version: 2 });
  });

  it('rechaza campos no permitidos, entidades desconocidas y lotes mal formados', async () => {
    const { user } = await setup();
    const token = await login(user.email);
    const res = await push(token, [
      op({ patch: { plate: plate(), version: 99 } }),
      op({ patch: { plate: plate(), color: 'rojo' } }),
      op({ entityType: 'camion' }),
      op({ patch: { plate: '!!' } }),
    ]).expect(200);
    expect(res.body.results[0].reason).toBe('campo_no_permitido:version');
    expect(res.body.results[1].reason).toBe('campo_no_permitido:color');
    expect(res.body.results[2].reason).toBe('entidad_desconocida');
    expect(res.body.results[3].result).toBe('rechazada');

    await push(token, []).expect(400);
    await request(http).post('/sync/push').set(bearer(token)).send({}).expect(400);
    await push(token, [{ operationId: 'no-es-uuid' }]).expect(400);
  });

  it('respeta los permisos: conductor y auditor no escriben, el encargado no da de baja', async () => {
    const { org, user: admin } = await setup();
    const driver = await createUser(owner, org, 'conductor_operador');
    const auditor = await createUser(owner, org, 'auditor');
    const fleet = await createUser(owner, org, 'vehiculos');
    const adminToken = await login(admin.email);
    const driverToken = await login(driver.email);
    const auditorToken = await login(auditor.email);
    const fleetToken = await login(fleet.email);

    const denied = await push(driverToken, [op()]).expect(200);
    expect(denied.body.results[0]).toMatchObject({ result: 'conflicto', conflictType: 'permiso' });
    expect((await push(auditorToken, [op()]).expect(200)).body.results[0]).toMatchObject({
      result: 'conflicto',
      conflictType: 'permiso',
    });

    // el conductor ve su propio conflicto y puede descartarlo
    const own = await request(http).get('/sync/conflicts').set(bearer(driverToken)).expect(200);
    expect(own.body).toHaveLength(1);
    await request(http)
      .post(`/sync/conflicts/${own.body[0].id}/resolve`)
      .set(bearer(driverToken))
      .send({ resolution: 'servidor' })
      .expect(200);

    const id = randomUUID();
    expect((await push(fleetToken, [op({ entityId: id })]).expect(200)).body.results[0].result).toBe('aplicada');
    const baja = await push(fleetToken, [op({ entityId: id, kind: 'delete', baseVersion: 1 })]).expect(200);
    expect(baja.body.results[0]).toMatchObject({ result: 'conflicto', conflictType: 'permiso' });

    const adminBaja = await push(adminToken, [
      op({ entityId: id, kind: 'delete', baseVersion: 1, patch: { deleteReason: 'vendido' } }),
    ]).expect(200);
    expect(adminBaja.body.results[0]).toMatchObject({ result: 'aplicada', version: 2 });

    // editar algo ya eliminado es un conflicto
    const late = await push(fleetToken, [op({ entityId: id, kind: 'update', baseVersion: 1, patch: { brand: 'X' } })]).expect(200);
    expect(late.body.results[0]).toMatchObject({ result: 'conflicto', conflictType: 'eliminado_remoto' });

    // la baja viaja a los demás dispositivos como cambio con deletedAt
    const record = (await pull(auditorToken).expect(200)).body.changes.find(
      (c: { entityId: string }) => c.entityId === id,
    ).record;
    expect(record.deletedAt).not.toBeNull();
    expect(record.deleteReason).toBe('vendido');
    // el conductor aún no tiene vehículos asignados (Etapa 3): su pull viene vacío
    expect((await pull(driverToken).expect(200)).body.changes).toEqual([]);
  });

  it('eliminar algo que otra persona modificó abre un conflicto', async () => {
    const { user } = await setup();
    const tokenA = await login(user.email);
    const tokenB = await login(user.email);
    const id = randomUUID();
    await push(tokenA, [op({ entityId: id })]).expect(200);
    await push(tokenA, [op({ entityId: id, kind: 'update', baseVersion: 1, patch: { brand: 'Toyota' } })]).expect(200);
    const res = await push(tokenB, [op({ entityId: id, kind: 'delete', baseVersion: 1 })]).expect(200);
    expect(res.body.results[0]).toMatchObject({ result: 'conflicto', conflictType: 'version' });
  });

  it('pagina el pull sin saltarse ni repetir cambios', async () => {
    const { user } = await setup();
    const token = await login(user.email);
    await push(token, [op(), op(), op(), op(), op()]).expect(200);

    const seen: number[] = [];
    let since = 0;
    for (let i = 0; i < 10; i++) {
      const page = (await pull(token, since, 2).expect(200)).body;
      for (const c of page.changes) seen.push(c.serverSeq);
      since = page.nextSeq;
      if (!page.hasMore) break;
    }
    expect(seen).toHaveLength(5);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(new Set(seen).size).toBe(5);
  });

  it('cada organización tiene su propia secuencia y no ve los vehículos de otra', async () => {
    const a = await setup();
    const b = await setup();
    const tokenA = await login(a.user.email);
    const tokenB = await login(b.user.email);
    const shared = plate();
    await push(tokenA, [op({ patch: { plate: shared } })]).expect(200);
    // la misma patente en otra organización es válida
    expect((await push(tokenB, [op({ patch: { plate: shared } })]).expect(200)).body.results[0].result).toBe('aplicada');

    const pa = (await pull(tokenA).expect(200)).body;
    const pb = (await pull(tokenB).expect(200)).body;
    expect(pa.changes).toHaveLength(1);
    expect(pb.changes).toHaveLength(1);
    expect(pa.changes[0].entityId).not.toBe(pb.changes[0].entityId);
  });

  it('sin sesión no se sincroniza', async () => {
    await request(http).post('/sync/push').send({ operations: [op()] }).expect(401);
    await request(http).post('/sync/pull').send({ sinceSeq: 0 }).expect(401);
  });
});
