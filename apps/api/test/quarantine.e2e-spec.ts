import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync, randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';
import request from 'supertest';
import { AuthClient } from '../../../packages/sync-client/src/auth-client';
import { AutoSync } from '../../../packages/sync-client/src/autosync';
import { SyncEngine } from '../../../packages/sync-client/src/engine';
import { PendingOperationsError } from '../../../packages/sync-client/src/errors';
import { SessionManager } from '../../../packages/sync-client/src/session';
import { LocalStore } from '../../../packages/sync-client/src/store';
import { FAST_KDF, memoryDb } from '../../../packages/sync-client/src/testing';
import { HttpTransport } from '../../../packages/sync-client/src/transport';
import { createOrg, createUser, PASSWORD } from './helpers';

jest.setTimeout(90000);

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;
const suite = OWNER_URL && APP_URL ? describe : describe.skip;
const PIN = 'pin-secreto-123';

suite('Recuperación de dispositivos revocados (PostgreSQL real)', () => {
  let app: INestApplication;
  let owner: Pool;
  let baseUrl: string;
  let publicKeyBase64: string;

  beforeAll(async () => {
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publicKeyBase64 = keys.publicKey.toString('base64');
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'prueba-jwt-secret-prueba-jwt-secret-0123456789';
    process.env.ALLOW_DEV_ACTOR = 'false';
    process.env.RECOVERY_PUBLIC_KEY = publicKeyBase64;
    process.env.RECOVERY_PRIVATE_KEY = keys.privateKey;
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    owner = new Pool({ connectionString: OWNER_URL });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.end();
  });

  const plate = () => `T${randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()}`;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function makeDevice(orgId: string, user: { id: string; email: string }, label: string) {
    const store = await LocalStore.open({
      orgId,
      userId: user.id,
      namespace: `${label}-${randomUUID()}`,
      kdf: FAST_KDF,
      ...memoryDb,
    });
    await store.initVault(PIN);
    const auth = new AuthClient(baseUrl);
    const transport = new HttpTransport({ baseUrl, getAccessToken: () => auth.getAccessToken() });
    const engine = new SyncEngine(store, transport, { runExclusive: (fn) => fn() });
    const autoSync = new AutoSync(engine, store, {
      windowLike: null,
      documentLike: null,
      intervalMs: 3_600_000,
      debounceMs: 50,
    });
    const session = new SessionManager({
      store,
      auth,
      engine,
      autoSync,
      orgId,
      userId: user.id,
      deviceLabel: label,
      platform: 'prueba',
      fetchRecoveryKey: async () => {
        const res = await fetch(`${baseUrl}/sync/recovery-key`, {
          headers: bearer(await auth.getAccessToken()),
        });
        return ((await res.json()) as { publicKey: string | null }).publicKey;
      },
    });
    await session.loginOnline(user.email, PASSWORD);
    autoSync.stop();
    return { store, auth, engine, autoSync, session };
  }

  async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > ms) throw new Error('Tiempo de espera agotado');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('del dispositivo revocado al administrador: nada se pierde y todo queda auditado', async () => {
    const orgId = await createOrg(owner, `Org recuperación ${randomUUID().slice(0, 6)}`);
    const admin = await createUser(owner, orgId, 'admin_general');
    const A = await makeDevice(orgId, admin, 'A');
    const B = await makeDevice(orgId, admin, 'B');
    const adminToken = await B.auth.getAccessToken();

    // el dispositivo recibió la llave pública de la organización al iniciar sesión
    expect(await A.store.getMeta('recoveryPublicKey')).toBe(publicKeyBase64);
    const keyRes = await request(app.getHttpServer()).get('/sync/recovery-key').set(bearer(adminToken)).expect(200);
    expect(keyRes.body.publicKey).toBe(publicKeyBase64);

    // trabajo ya sincronizado y trabajo pendiente en A
    const synced = await A.store.create('vehicle', { plate: plate() });
    await A.engine.syncOnce();
    await A.store.update('vehicle', synced.id, { brand: 'Toyota' });
    const pendingPlate = plate();
    await A.store.create('vehicle', { plate: pendingPlate });
    expect(await A.store.pendingCount()).toBe(2);

    // el administrador revoca el dispositivo; A lo descubre al intentar sincronizar
    await request(app.getHttpServer())
      .post(`/devices/${A.store.deviceId}/revoke`)
      .set(bearer(adminToken))
      .send({ status: 'perdido' })
      .expect(200);
    A.autoSync.start();
    await waitFor(() => A.session.state.kind === 'quarantine');
    expect(A.session.state).toMatchObject({ kind: 'quarantine', reason: 'DEVICE_REVOKED', pending: 2 });
    await expect(A.session.finishQuarantine()).rejects.toBeInstanceOf(PendingOperationsError);

    // paquete de recuperación: viaja cifrado y solo el servidor lo abre
    const bundleJson = await A.session.exportRecovery(PIN);
    expect(bundleJson).not.toContain(pendingPlate);
    const bundle = JSON.parse(bundleJson);

    const imported = await request(app.getHttpServer())
      .post('/sync/quarantine/import')
      .set(bearer(adminToken))
      .send({ bundle })
      .expect(201);
    expect(imported.body.opCount).toBe(2);
    // el mismo paquete no se importa dos veces
    await request(app.getHttpServer()).post('/sync/quarantine/import').set(bearer(adminToken)).send({ bundle }).expect(409);

    const pending = await request(app.getHttpServer()).get('/sync/quarantine').set(bearer(adminToken)).expect(200);
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({ sourceDeviceId: A.store.deviceId, sourceUserEmail: admin.email, opCount: 2 });
    const patches = pending.body[0].payload.ops.map((o: { patch: Record<string, unknown> }) => o.patch);
    expect(patches).toEqual(expect.arrayContaining([{ brand: 'Toyota' }, { plate: pendingPlate }]));

    // las operaciones recuperadas NO se aplicaron solas
    const pulled = await request(app.getHttpServer())
      .post('/sync/pull')
      .set(bearer(adminToken))
      .send({ sinceSeq: 0 })
      .expect(200);
    expect(pulled.body.changes.some((c: { record: { plate: string } }) => c.record.plate === pendingPlate)).toBe(false);

    // revisión del administrador
    const id = pending.body[0].id;
    await request(app.getHttpServer())
      .post(`/sync/quarantine/${id}/review`)
      .set(bearer(adminToken))
      .send({ status: 'aceptada', note: 'Registrado manualmente' })
      .expect(200);
    expect((await request(app.getHttpServer()).get('/sync/quarantine').set(bearer(adminToken)).expect(200)).body).toHaveLength(0);
    const accepted = await request(app.getHttpServer())
      .get('/sync/quarantine?status=aceptada')
      .set(bearer(adminToken))
      .expect(200);
    expect(accepted.body[0]).toMatchObject({ id, note: 'Registrado manualmente' });
    await request(app.getHttpServer()).post(`/sync/quarantine/${id}/review`).set(bearer(adminToken)).send({ status: 'descartada' }).expect(404);

    const audit = await request(app.getHttpServer()).get('/audit?limit=200').set(bearer(adminToken)).expect(200);
    const actions = audit.body.map((r: { action: string }) => r.action);
    expect(actions).toContain('QUARANTINE_IMPORT');
    expect(actions).toContain('QUARANTINE_REVIEW');

    // con el paquete entregado, el equipo ya puede borrarse
    await A.session.finishQuarantine();
    expect(A.session.state.kind).toBe('logged-out');
  });

  it('rechaza paquetes alterados, de otra organización o enviados por quien no administra', async () => {
    const orgId = await createOrg(owner, `Org paquetes ${randomUUID().slice(0, 6)}`);
    const admin = await createUser(owner, orgId, 'admin_general');
    const driver = await createUser(owner, orgId, 'conductor_operador');
    const adminDevice = await makeDevice(orgId, admin, 'admin');
    const adminToken = await adminDevice.auth.getAccessToken();

    const otherOrg = await createOrg(owner, `Otra org ${randomUUID().slice(0, 6)}`);
    const otherUser = await createUser(owner, otherOrg, 'admin_general');
    const otherDevice = await makeDevice(otherOrg, otherUser, 'otra');
    await otherDevice.store.create('vehicle', { plate: plate() });
    const foreign = JSON.parse(await otherDevice.session.exportRecovery(PIN));

    const mine = await makeDevice(orgId, driver, 'conductor');
    await mine.store.create('vehicle', { plate: plate() });
    const valid = JSON.parse(await mine.session.exportRecovery(PIN));

    // alterado: ya no se puede abrir
    const tampered = { ...valid, data: `${valid.data.startsWith('A') ? 'B' : 'A'}${valid.data.slice(1)}` };
    await request(app.getHttpServer()).post('/sync/quarantine/import').set(bearer(adminToken)).send({ bundle: tampered }).expect(400);
    // basura
    await request(app.getHttpServer()).post('/sync/quarantine/import').set(bearer(adminToken)).send({ bundle: { v: 1 } }).expect(400);
    await request(app.getHttpServer()).post('/sync/quarantine/import').set(bearer(adminToken)).send({}).expect(400);
    // de otra organización
    await request(app.getHttpServer()).post('/sync/quarantine/import').set(bearer(adminToken)).send({ bundle: foreign }).expect(403);
    // quien no administra dispositivos no puede importar ni ver la cuarentena
    const driverToken = await mine.auth.getAccessToken();
    await request(app.getHttpServer()).post('/sync/quarantine/import').set(bearer(driverToken)).send({ bundle: valid }).expect(403);
    await request(app.getHttpServer()).get('/sync/quarantine').set(bearer(driverToken)).expect(403);
    // sin sesión
    await request(app.getHttpServer()).get('/sync/quarantine').expect(401);

    // el paquete legítimo sí se acepta
    await request(app.getHttpServer()).post('/sync/quarantine/import').set(bearer(adminToken)).send({ bundle: valid }).expect(201);
  });
});
