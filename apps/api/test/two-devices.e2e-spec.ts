import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';
import request from 'supertest';
import { AuthClient } from '../../../packages/sync-client/src/auth-client';
import { SyncEngine } from '../../../packages/sync-client/src/engine';
import { NetworkError, PendingOperationsError, SessionError } from '../../../packages/sync-client/src/errors';
import type {
  ConflictResolution,
  PullRequest,
  PullResponse,
  PushOperation,
  PushResponse,
  ResolveResponse,
  ServerConflict,
} from '../../../packages/sync-client/src/protocol';
import { LocalStore } from '../../../packages/sync-client/src/store';
import { FAST_KDF, memoryDb } from '../../../packages/sync-client/src/testing';
import { HttpTransport, SyncTransport } from '../../../packages/sync-client/src/transport';
import { createOrg, createUser, PASSWORD } from './helpers';

jest.setTimeout(90000);

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;
const suite = OWNER_URL && APP_URL ? describe : describe.skip;
const PIN = 'pin-secreto-123';

/** Transporte que permite simular corte de red y respuestas perdidas. */
class FlakyTransport implements SyncTransport {
  offline = false;
  loseNextPushResponse = false;

  constructor(private readonly inner: SyncTransport) {}

  private check(): void {
    if (this.offline) throw new NetworkError();
  }

  async push(operations: PushOperation[]): Promise<PushResponse> {
    this.check();
    const response = await this.inner.push(operations);
    if (this.loseNextPushResponse) {
      this.loseNextPushResponse = false;
      throw new NetworkError('respuesta perdida');
    }
    return response;
  }

  pull(request: PullRequest): Promise<PullResponse> {
    this.check();
    return this.inner.pull(request);
  }

  listConflicts(): Promise<ServerConflict[]> {
    this.check();
    return this.inner.listConflicts();
  }

  resolveConflict(id: string, resolution: ConflictResolution, patch?: Record<string, unknown>): Promise<ResolveResponse> {
    this.check();
    return this.inner.resolveConflict(id, resolution, patch);
  }
}

suite('Dos dispositivos reales contra el servidor (PostgreSQL real)', () => {
  let app: INestApplication;
  let owner: Pool;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'prueba-jwt-secret-prueba-jwt-secret-0123456789';
    process.env.ALLOW_DEV_ACTOR = 'false';
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

  interface Device {
    label: string;
    namespace: string;
    orgId: string;
    userId: string;
    store: LocalStore;
    auth: AuthClient;
    transport: FlakyTransport;
    engine: SyncEngine;
  }

  async function makeDevice(orgId: string, user: { id: string; email: string }, label: string): Promise<Device> {
    const namespace = `${label}-${randomUUID()}`;
    const store = await LocalStore.open({ orgId, userId: user.id, namespace, kdf: FAST_KDF, ...memoryDb });
    await store.initVault(PIN);
    const auth = new AuthClient(baseUrl);
    await auth.login({
      email: user.email,
      password: PASSWORD,
      deviceId: store.deviceId,
      deviceLabel: label,
      platform: 'prueba',
    });
    const transport = new FlakyTransport(new HttpTransport({ baseUrl, getAccessToken: () => auth.getAccessToken() }));
    return { label, namespace, orgId, userId: user.id, store, auth, transport, engine: new SyncEngine(store, transport) };
  }

  async function fleet() {
    const orgId = await createOrg(owner, `Org dispositivos ${randomUUID().slice(0, 6)}`);
    const user = await createUser(owner, orgId, 'admin_general');
    const A = await makeDevice(orgId, user, 'A');
    const B = await makeDevice(orgId, user, 'B');
    return { orgId, user, A, B };
  }

  const plates = async (d: Device) => (await d.store.list('vehicle')).map((r) => r.fields.plate as string).sort();
  const brandOf = async (d: Device, id: string) => (await d.store.get('vehicle', id))?.fields.brand;

  /** Un vehículo creado en A y ya presente en ambos dispositivos. */
  async function baseline(A: Device, B: Device, fields: Record<string, unknown> = {}) {
    const rec = await A.store.create('vehicle', { plate: plate(), ...fields });
    await A.engine.syncOnce();
    await B.engine.syncOnce();
    return rec.id;
  }

  it('lo creado sin conexión se envía al volver la red y llega al otro dispositivo', async () => {
    const { A, B } = await fleet();
    A.transport.offline = true;
    const p = plate();
    const rec = await A.store.create('vehicle', { plate: p, brand: 'Toyota' });

    const offline = await A.engine.syncOnce();
    expect(offline.status).toBe('offline');
    expect(await A.store.pendingCount()).toBe(1);
    expect((await A.store.get('vehicle', rec.id))?.syncStatus).toBe('pendiente');

    A.transport.offline = false;
    const online = await A.engine.syncOnce();
    expect(online).toMatchObject({ status: 'ok', applied: 1, conflicts: 0 });
    expect(await A.store.pendingCount()).toBe(0);
    expect(await A.store.get('vehicle', rec.id)).toMatchObject({ syncStatus: 'sincronizado', server: { version: 1 } });

    await B.engine.syncOnce();
    const received = await B.store.get('vehicle', rec.id);
    expect(received?.fields).toMatchObject({ plate: p, brand: 'Toyota' });
    expect(received?.server?.createdDeviceId).toBe(A.store.deviceId);
  });

  it('si se pierde la respuesta del servidor, reenviar no duplica nada', async () => {
    const { A, B } = await fleet();
    A.transport.loseNextPushResponse = true;
    const rec = await A.store.create('vehicle', { plate: plate() });

    expect((await A.engine.syncOnce()).status).toBe('offline');
    expect(await A.store.pendingCount()).toBe(1);

    const retry = await A.engine.syncOnce();
    expect(retry).toMatchObject({ status: 'ok', applied: 0, duplicates: 1 });
    expect(await A.store.pendingCount()).toBe(0);

    await B.engine.syncOnce();
    expect(await B.store.list('vehicle')).toHaveLength(1);
    expect((await B.store.get('vehicle', rec.id))?.server?.version).toBe(1);
  });

  it('cambios en campos distintos desde dos dispositivos se combinan solos', async () => {
    const { A, B } = await fleet();
    const id = await baseline(A, B);
    await A.store.update('vehicle', id, { brand: 'Toyota' });
    await B.store.update('vehicle', id, { model: 'Yaris' });

    await A.engine.syncOnce();
    const b = await B.engine.syncOnce();
    expect(b).toMatchObject({ conflicts: 0, applied: 1 });
    await A.engine.syncOnce();

    for (const d of [A, B]) {
      const rec = await d.store.get('vehicle', id);
      expect(rec?.fields).toMatchObject({ brand: 'Toyota', model: 'Yaris' });
      expect(rec?.syncStatus).toBe('sincronizado');
      expect(rec?.server?.version).toBe(3);
    }
  });

  it('varios cambios sin conexión sobre un mismo registro viajan como un solo cambio', async () => {
    const { A, B } = await fleet();
    const id = await baseline(A, B);
    await A.store.update('vehicle', id, { brand: 'Uno' });
    await A.store.update('vehicle', id, { brand: 'Dos' });
    await A.store.update('vehicle', id, { brand: 'Tres', year: 2022 });
    const report = await A.engine.syncOnce();
    expect(report.applied).toBe(1);
    await B.engine.syncOnce();
    expect((await B.store.get('vehicle', id))?.server?.version).toBe(2);
    expect((await B.store.get('vehicle', id))?.fields).toMatchObject({ brand: 'Tres', year: 2022 });
  });

  it('el mismo campo crítico cambiado en dos dispositivos abre un conflicto que se resuelve y converge', async () => {
    const { A, B } = await fleet();
    const id = await baseline(A, B);
    await A.store.update('vehicle', id, { brand: 'Toyota' });
    await B.store.update('vehicle', id, { brand: 'Nissan' });

    await A.engine.syncOnce();
    const b = await B.engine.syncOnce();
    expect(b.conflicts).toBe(1);
    expect((await B.store.get('vehicle', id))?.syncStatus).toBe('conflicto');
    expect(await brandOf(B, id)).toBe('Nissan'); // lo local no se pierde mientras se decide
    const conflicts = await B.store.listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ conflictType: 'version', conflictingFields: ['brand'] });

    // mientras hay conflicto, otro cambio sobre el mismo registro espera sin perderse
    await B.store.update('vehicle', id, { model: 'Versa' });
    expect((await B.engine.syncOnce()).applied).toBe(0);
    expect(await B.store.pendingCount()).toBe(2);

    await B.engine.resolveConflict(conflicts[0].id, 'cliente');
    expect((await B.store.get('vehicle', id))?.syncStatus).toBe('pendiente');
    expect((await B.engine.syncOnce()).applied).toBe(1); // ahora sí sale el cambio de modelo
    await A.engine.syncOnce();
    await B.engine.syncOnce();

    for (const d of [A, B]) {
      const rec = await d.store.get('vehicle', id);
      expect(rec?.fields).toMatchObject({ brand: 'Nissan', model: 'Versa' });
      expect(rec?.syncStatus).toBe('sincronizado');
      expect(await d.store.pendingCount()).toBe(0);
    }
  });

  it('aceptar la versión del servidor descarta el cambio local y ambos quedan iguales', async () => {
    const { A, B } = await fleet();
    const id = await baseline(A, B);
    await A.store.update('vehicle', id, { brand: 'Toyota' });
    await B.store.update('vehicle', id, { brand: 'Nissan' });
    await A.engine.syncOnce();
    await B.engine.syncOnce();
    const [conflict] = await B.store.listConflicts();
    await B.engine.resolveConflict(conflict.id, 'servidor');

    expect(await brandOf(B, id)).toBe('Toyota');
    expect((await B.store.get('vehicle', id))?.syncStatus).toBe('sincronizado');
    expect(await B.store.pendingCount()).toBe(0);
    await B.engine.syncOnce();
    expect(await brandOf(A, id)).toBe('Toyota');
  });

  it('el mismo vehículo creado sin conexión en dos dispositivos se detecta y queda uno solo', async () => {
    const { A, B } = await fleet();
    const p = plate();
    A.transport.offline = true;
    B.transport.offline = true;
    const recA = await A.store.create('vehicle', { plate: p, brand: 'Toyota' });
    const recB = await B.store.create('vehicle', { plate: p });
    A.transport.offline = false;
    B.transport.offline = false;

    await A.engine.syncOnce();
    const b = await B.engine.syncOnce();
    expect(b.conflicts).toBe(1);
    const [conflict] = await B.store.listConflicts();
    expect(conflict.conflictType).toBe('duplicado_probable');

    await B.engine.resolveConflict(conflict.id, 'servidor');
    expect(await B.store.get('vehicle', recB.id)).toBeUndefined(); // el duplicado local desaparece
    expect(await B.store.get('vehicle', recA.id)).toBeDefined(); // y se adopta el que ya existía
    expect(await B.store.pendingCount()).toBe(0);

    await A.engine.syncOnce();
    await B.engine.syncOnce();
    expect(await plates(A)).toEqual([p]);
    expect(await plates(B)).toEqual([p]);
  });

  it('eliminar en un dispositivo y editar en otro abre un conflicto y converge', async () => {
    const { A, B } = await fleet();
    const id = await baseline(A, B);
    await A.store.remove('vehicle', id, { reason: 'vendido' });
    await A.engine.syncOnce();
    await B.store.update('vehicle', id, { brand: 'Tardío' });
    await B.engine.syncOnce();
    const [conflict] = await B.store.listConflicts();
    expect(conflict.conflictType).toBe('eliminado_remoto');
    await B.engine.resolveConflict(conflict.id, 'servidor');
    expect(await B.store.list('vehicle')).toHaveLength(0);
    expect(await A.store.list('vehicle')).toHaveLength(0);
    expect(await B.store.pendingCount()).toBe(0);
  });

  it('si la aplicación se cierra a mitad del envío, al reabrir no se pierde ni se duplica nada', async () => {
    const { orgId, user, A, B } = await fleet();
    const rec = await A.store.create('vehicle', { plate: plate() });

    // el servidor recibe y aplica el cambio, pero la aplicación se cierra antes de anotarlo
    const batch = await A.store.nextBatch(50);
    await A.store.markInFlight(batch);
    await new HttpTransport({ baseUrl, getAccessToken: () => A.auth.getAccessToken() }).push(batch.map((b) => b.op));
    A.store.close();

    const reopened = await LocalStore.open({ orgId, userId: user.id, namespace: A.namespace, kdf: FAST_KDF, ...memoryDb });
    await reopened.unlock(PIN);
    const engine = new SyncEngine(reopened, A.transport);
    const report = await engine.syncOnce();
    expect(report).toMatchObject({ status: 'ok', applied: 0, duplicates: 1 });
    expect(await reopened.pendingCount()).toBe(0);
    expect((await reopened.get('vehicle', rec.id))?.syncStatus).toBe('sincronizado');

    await B.engine.syncOnce();
    expect(await B.store.list('vehicle')).toHaveLength(1);
  });

  it('no se pueden borrar los datos locales mientras haya registros sin sincronizar', async () => {
    const { A } = await fleet();
    A.transport.offline = true;
    await A.store.create('vehicle', { plate: plate() });
    await A.engine.syncOnce();
    await expect(A.store.safeWipe()).rejects.toBeInstanceOf(PendingOperationsError);

    A.transport.offline = false;
    await A.engine.syncOnce();
    await A.store.safeWipe();
    expect(A.store.isUnlocked).toBe(false);
  });

  it('un dispositivo revocado pierde el acceso pero conserva sus registros pendientes', async () => {
    const { A, B } = await fleet();
    A.transport.offline = true;
    await A.store.create('vehicle', { plate: plate() });
    await A.engine.syncOnce();
    A.transport.offline = false;

    const adminToken = await B.auth.getAccessToken();
    await request(app.getHttpServer())
      .post(`/devices/${A.store.deviceId}/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'perdido' })
      .expect(200);

    await expect(A.engine.syncOnce()).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    await expect(A.engine.syncOnce()).rejects.toBeInstanceOf(SessionError);
    expect(await A.store.pendingCount()).toBe(1); // nada se perdió
    expect(await A.store.list('vehicle')).toHaveLength(1);
  });

  it('dos sincronizaciones simultáneas comparten una sola ejecución', async () => {
    const { A } = await fleet();
    await A.store.create('vehicle', { plate: plate() });
    const first = A.engine.syncOnce();
    const second = A.engine.syncOnce();
    expect(second).toBe(first);
    expect((await first).applied).toBe(1);
  });
});
