import Dexie from 'dexie';
import { randomUUID } from 'crypto';
import {
  PendingOperationsError,
  ReauthRequiredError,
  TamperError,
  UnlockThrottledError,
  VaultLockedError,
  WrongSecretError,
} from '../src/errors';
import type { OperationResult } from '../src/protocol';
import { LocalStore } from '../src/store';
import { FAST_KDF, memoryDb } from '../src/testing';

jest.setTimeout(30000);

const SECRET = 'pin-secreto-123';
const ORG = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = '11111111-0000-0000-0000-000000000001';

function options(namespace: string, now?: () => number) {
  return { orgId: ORG, userId: USER, namespace, kdf: FAST_KDF, now, ...memoryDb };
}

async function openUnlocked(namespace = randomUUID()): Promise<{ store: LocalStore; namespace: string }> {
  const store = await LocalStore.open(options(namespace));
  await store.initVault(SECRET);
  return { store, namespace };
}

const applied = (operationId: string, version: number, serverSeq = version): OperationResult => ({
  operationId,
  result: 'aplicada',
  version,
  serverSeq,
  merged: false,
});

/** Simula un envío exitoso de todo lo pendiente y devuelve las operaciones enviadas. */
async function syncAll(store: LocalStore, version: number) {
  const batch = await store.nextBatch(50);
  await store.markInFlight(batch);
  await store.applyPushResults(
    batch,
    batch.map((b) => applied(b.operationId, version)),
  );
  return batch;
}

const serverRecord = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  version: 1,
  serverSeq: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  clientCreatedAt: null,
  clientUpdatedAt: null,
  createdBy: null,
  updatedBy: null,
  createdDeviceId: null,
  updatedDeviceId: null,
  deletedAt: null,
  deleteReason: null,
  plate: 'AB1234',
  brand: null,
  ...over,
});

describe('bóveda y claves', () => {
  it('protege los datos con contraseña: bloquear, desbloquear y rechazar claves incorrectas', async () => {
    const store = await LocalStore.open(options(randomUUID()));
    expect(await store.hasVault()).toBe(false);
    await store.initVault(SECRET);
    expect(store.isUnlocked).toBe(true);

    await store.create('vehicle', { plate: 'AB1234' });
    store.lock();
    expect(store.isUnlocked).toBe(false);
    await expect(store.create('vehicle', { plate: 'CD5678' })).rejects.toBeInstanceOf(VaultLockedError);
    await expect(store.list('vehicle')).rejects.toBeInstanceOf(VaultLockedError);

    await expect(store.unlock('otra-clave-123')).rejects.toBeInstanceOf(WrongSecretError);
    await store.unlock(SECRET);
    expect(await store.list('vehicle')).toHaveLength(1);
  });

  it('frena los intentos repetidos y exige conexión tras demasiados fallos, sin borrar nada', async () => {
    let clock = 1_000_000;
    const namespace = randomUUID();
    const store = await LocalStore.open(options(namespace, () => clock));
    await store.initVault(SECRET);
    await store.create('vehicle', { plate: 'AB1234' });
    store.lock();

    for (let i = 0; i < 3; i++) {
      await expect(store.unlock('mala-clave-1')).rejects.toBeInstanceOf(WrongSecretError);
    }
    // el tercer fallo activa una espera, incluso con la clave correcta
    await expect(store.unlock(SECRET)).rejects.toBeInstanceOf(UnlockThrottledError);

    for (let i = 3; i < 10; i++) {
      clock += 10 * 60 * 1000;
      await expect(store.unlock('mala-clave-1')).rejects.toBeInstanceOf(WrongSecretError);
    }
    clock += 10 * 60 * 1000;
    await expect(store.unlock(SECRET)).rejects.toBeInstanceOf(ReauthRequiredError);

    // tras iniciar sesión en línea se rehabilita, y los datos siguen ahí
    await store.resetUnlockAttempts();
    await store.unlock(SECRET);
    expect(await store.list('vehicle')).toHaveLength(1);
  });

  it('los datos quedan cifrados en el almacenamiento y ligados a su registro', async () => {
    const { store, namespace } = await openUnlocked();
    const a = await store.create('vehicle', { plate: 'PLACA-SECRETA', notes: 'nota-privada-xyz' });
    const b = await store.create('vehicle', { plate: 'OTRA-PLACA' });

    const raw = new Dexie(`sgv_${ORG}_${USER}_${namespace}`, memoryDb);
    await raw.open();
    const dump = JSON.stringify({
      records: await raw.table('records').toArray(),
      outbox: await raw.table('outbox').toArray(),
      meta: await raw.table('meta').toArray(),
    });
    expect(dump).not.toContain('PLACA-SECRETA');
    expect(dump).not.toContain('nota-privada-xyz');
    expect(dump).not.toContain(SECRET);

    // copiar el contenido cifrado de un registro a otro es detectado
    const rowA = await raw.table('records').get(['vehicle', a.id]);
    const rowB = await raw.table('records').get(['vehicle', b.id]);
    await raw.table('records').put({ ...rowB, enc: rowA.enc });
    raw.close();
    await expect(store.get('vehicle', b.id)).rejects.toBeInstanceOf(TamperError);
    await expect(store.get('vehicle', a.id)).resolves.toBeDefined();
  });
});

describe('cola de cambios', () => {
  it('crear deja el registro pendiente y una operación en cola; un doble toque no duplica', async () => {
    const { store } = await openUnlocked();
    const ids = { entityId: randomUUID(), operationId: randomUUID() };
    const first = await store.create('vehicle', { plate: 'AB1234' }, ids);
    const second = await store.create('vehicle', { plate: 'AB1234' }, ids);
    expect(first.id).toBe(second.id);
    expect(first.syncStatus).toBe('pendiente');
    expect(await store.pendingCount()).toBe(1);
    expect(await store.list('vehicle')).toHaveLength(1);
  });

  it('los cambios sucesivos antes de enviar se acumulan en una sola operación', async () => {
    const { store } = await openUnlocked();
    const rec = await store.create('vehicle', { plate: 'AB1234' });
    await store.update('vehicle', rec.id, { brand: 'Toyota' });
    await store.update('vehicle', rec.id, { brand: 'Nissan', model: 'Versa' });
    const batch = await store.nextBatch(50);
    expect(batch).toHaveLength(1);
    expect(batch[0].op).toMatchObject({
      kind: 'create',
      baseVersion: null,
      patch: { plate: 'AB1234', brand: 'Nissan', model: 'Versa' },
    });
  });

  it('crear y eliminar antes de sincronizar no deja rastro', async () => {
    const { store } = await openUnlocked();
    const rec = await store.create('vehicle', { plate: 'AB1234' });
    await store.remove('vehicle', rec.id);
    expect(await store.pendingCount()).toBe(0);
    expect(await store.get('vehicle', rec.id)).toBeUndefined();
  });

  it('tras sincronizar, editar usa la versión del servidor y respeta el orden de envío', async () => {
    const { store } = await openUnlocked();
    const rec = await store.create('vehicle', { plate: 'AB1234' });
    await syncAll(store, 1);
    const synced = await store.get('vehicle', rec.id);
    expect(synced).toMatchObject({ syncStatus: 'sincronizado', server: { version: 1 }, dirtyFields: [] });
    expect(await store.pendingCount()).toBe(0);

    await store.update('vehicle', rec.id, { brand: 'Toyota' });
    const firstBatch = await store.nextBatch(50);
    expect(firstBatch[0].op).toMatchObject({ kind: 'update', baseVersion: 1, patch: { brand: 'Toyota' } });
    await store.markInFlight(firstBatch);

    // mientras el primero está en vuelo, otro cambio queda detrás y no sale en el mismo envío
    await store.update('vehicle', rec.id, { model: 'Yaris' });
    expect(await store.nextBatch(50)).toHaveLength(0);

    await store.applyPushResults(firstBatch, [applied(firstBatch[0].operationId, 2)]);
    const secondBatch = await store.nextBatch(50);
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0].op).toMatchObject({ kind: 'update', baseVersion: 2, patch: { model: 'Yaris' } });
  });

  it('un conflicto bloquea los cambios siguientes del mismo registro y no los de otros', async () => {
    const { store } = await openUnlocked();
    const a = await store.create('vehicle', { plate: 'AAA111' });
    const b = await store.create('vehicle', { plate: 'BBB222' });
    await syncAll(store, 1);

    await store.update('vehicle', a.id, { brand: 'X' });
    const batch = await store.nextBatch(50);
    await store.markInFlight(batch);
    await store.applyPushResults(batch, [
      { operationId: batch[0].operationId, result: 'conflicto', conflictId: randomUUID(), conflictType: 'version', conflictingFields: ['brand'] },
    ]);
    expect((await store.get('vehicle', a.id))?.syncStatus).toBe('conflicto');

    await store.update('vehicle', a.id, { model: 'Y' });
    await store.update('vehicle', b.id, { brand: 'Z' });
    const next = await store.nextBatch(50);
    expect(next.map((n) => n.entityId)).toEqual([b.id]);
    expect((await store.stats()).conflicts).toBe(1);
  });

  it('eliminar un registro ya sincronizado genera una baja con la versión conocida', async () => {
    const { store } = await openUnlocked();
    const rec = await store.create('vehicle', { plate: 'AB1234' });
    await syncAll(store, 1);
    await store.update('vehicle', rec.id, { brand: 'Toyota' }); // cambio pendiente que la baja reemplaza
    await store.remove('vehicle', rec.id, { reason: 'vendido' });
    const batch = await store.nextBatch(50);
    expect(batch).toHaveLength(1);
    expect(batch[0].op).toMatchObject({ kind: 'delete', baseVersion: 1, patch: { deleteReason: 'vendido' } });
    expect(await store.list('vehicle')).toHaveLength(0);
    expect(await store.list('vehicle', { includeDeleted: true })).toHaveLength(1);
  });
});

describe('persistencia y recuperación', () => {
  it('los datos y la cola sobreviven al cierre de la aplicación', async () => {
    const { store, namespace } = await openUnlocked();
    const rec = await store.create('vehicle', { plate: 'AB1234' });
    const deviceId = store.deviceId;
    store.close();

    const reopened = await LocalStore.open(options(namespace));
    expect(reopened.deviceId).toBe(deviceId);
    expect(reopened.isUnlocked).toBe(false);
    await reopened.unlock(SECRET);
    expect((await reopened.get('vehicle', rec.id))?.fields.plate).toBe('AB1234');
    expect(await reopened.pendingCount()).toBe(1);
  });

  it('lo que estaba en vuelo cuando se cerró la aplicación vuelve a la cola', async () => {
    const { store, namespace } = await openUnlocked();
    await store.create('vehicle', { plate: 'AB1234' });
    const batch = await store.nextBatch(50);
    await store.markInFlight(batch);
    expect(await store.nextBatch(50)).toHaveLength(0);
    store.close();

    const reopened = await LocalStore.open(options(namespace));
    await reopened.unlock(SECRET);
    expect(await reopened.recoverInFlight()).toBe(1);
    expect(await reopened.nextBatch(50)).toHaveLength(1);
  });

  it('no permite borrar los datos locales con registros pendientes', async () => {
    const { store } = await openUnlocked();
    await store.create('vehicle', { plate: 'AB1234' });
    await expect(store.safeWipe()).rejects.toBeInstanceOf(PendingOperationsError);
    expect(await store.list('vehicle')).toHaveLength(1);

    await syncAll(store, 1);
    await store.safeWipe();
    expect(store.isUnlocked).toBe(false);
  });
});

describe('cambios que llegan del servidor', () => {
  it('incorpora registros nuevos y eliminaciones', async () => {
    const { store } = await openUnlocked();
    const id = randomUUID();
    await store.applyPullChanges({
      changes: [{ entityType: 'vehicle', entityId: id, version: 1, serverSeq: 5, record: serverRecord(id, { serverSeq: 5 }) }],
      nextSeq: 5,
      hasMore: false,
      requiresFullResync: false,
    });
    expect(await store.getCursor()).toBe(5);
    expect(await store.get('vehicle', id)).toMatchObject({ syncStatus: 'sincronizado', fields: { plate: 'AB1234' } });

    await store.applyPullChanges({
      changes: [
        {
          entityType: 'vehicle',
          entityId: id,
          version: 2,
          serverSeq: 6,
          record: serverRecord(id, { version: 2, serverSeq: 6, deletedAt: '2026-02-01T00:00:00.000Z' }),
        },
      ],
      nextSeq: 6,
      hasMore: false,
      requiresFullResync: false,
    });
    expect(await store.list('vehicle')).toHaveLength(0);
  });

  it('no pisa el trabajo local sin confirmar: solo actualiza lo que se sabe del servidor', async () => {
    const { store } = await openUnlocked();
    const id = randomUUID();
    await store.applyPullChanges({
      changes: [{ entityType: 'vehicle', entityId: id, version: 1, serverSeq: 1, record: serverRecord(id) }],
      nextSeq: 1,
      hasMore: false,
      requiresFullResync: false,
    });
    await store.update('vehicle', id, { brand: 'Local' });
    await store.applyPullChanges({
      changes: [
        { entityType: 'vehicle', entityId: id, version: 2, serverSeq: 2, record: serverRecord(id, { version: 2, serverSeq: 2, brand: 'Remota' }) },
      ],
      nextSeq: 2,
      hasMore: false,
      requiresFullResync: false,
    });
    const rec = await store.get('vehicle', id);
    expect(rec?.fields.brand).toBe('Local');
    expect(rec?.server?.version).toBe(2);
    expect(rec?.syncStatus).toBe('pendiente');
  });
});
