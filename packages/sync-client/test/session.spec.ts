import { randomUUID } from 'crypto';
import { b64decode, toArrayBuffer } from '../src/bytes';
import type { AutoSyncLike, AutoSyncStatus } from '../src/autosync';
import { SyncEngine } from '../src/engine';
import { GraceExpiredError, NetworkError, NoRecoveryKeyError, PendingOperationsError } from '../src/errors';
import type {
  ConflictResolution,
  PullRequest,
  PullResponse,
  PushOperation,
  PushResponse,
  ResolveResponse,
  ServerConflict,
} from '../src/protocol';
import { RECOVERY_AAD, RecoveryBundle, RecoveryPayload } from '../src/recovery';
import { SessionManager } from '../src/session';
import { LocalStore } from '../src/store';
import { FAST_KDF, memoryDb } from '../src/testing';
import type { SyncTransport } from '../src/transport';

jest.setTimeout(30000);

const PIN = 'pin-secreto-123';
const ORG = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = '11111111-0000-0000-0000-000000000001';
const DAY = 24 * 60 * 60 * 1000;

class FakeServer implements SyncTransport {
  offline = false;
  private version = 0;
  async push(operations: PushOperation[]): Promise<PushResponse> {
    if (this.offline) throw new NetworkError();
    return {
      results: operations.map((o) => ({
        operationId: o.operationId,
        result: 'aplicada' as const,
        version: ++this.version,
        serverSeq: this.version,
        merged: false,
      })),
    };
  }
  async pull(request: PullRequest): Promise<PullResponse> {
    if (this.offline) throw new NetworkError();
    return { changes: [], nextSeq: request.sinceSeq, hasMore: false, requiresFullResync: false };
  }
  async listConflicts(): Promise<ServerConflict[]> {
    return [];
  }
  async resolveConflict(_id: string, _r: ConflictResolution): Promise<ResolveResponse> {
    throw new Error('no usado');
  }
}

class StubAutoSync implements AutoSyncLike {
  started = false;
  private listeners = new Set<(s: AutoSyncStatus) => void>();
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
  onStatus(listener: (s: AutoSyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(status: AutoSyncStatus): void {
    for (const l of this.listeners) l(status);
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > ms) throw new Error('Tiempo de espera agotado');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(extra: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  let clock = 1_700_000_000_000;
  const store = await LocalStore.open({
    orgId: ORG,
    userId: USER,
    namespace: randomUUID(),
    kdf: FAST_KDF,
    now: () => clock,
    ...memoryDb,
  });
  await store.initVault(PIN);
  const server = new FakeServer();
  const engine = new SyncEngine(store, server, { runExclusive: (fn) => fn() });
  const auth = {
    isLoggedIn: true,
    login: jest.fn(async () => undefined),
    logout: jest.fn(async () => undefined),
  };
  const autoSync = new StubAutoSync();
  const session = new SessionManager({
    store,
    auth,
    engine,
    autoSync,
    orgId: ORG,
    userId: USER,
    now: () => clock,
    ...extra,
  });
  return { store, server, auth, autoSync, session, advance: (ms: number) => (clock += ms), now: () => clock };
}

async function rsaKeys() {
  const subtle = globalThis.crypto.subtle;
  const pair = (await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  return { spkiBase64: Buffer.from(spki).toString('base64'), pkcs8 };
}

async function openBundle(json: string, pkcs8: Uint8Array): Promise<RecoveryPayload> {
  const subtle = globalThis.crypto.subtle;
  const bundle = JSON.parse(json) as RecoveryBundle;
  const priv = await subtle.importKey('pkcs8', toArrayBuffer(pkcs8), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, priv, toArrayBuffer(b64decode(bundle.wrappedKey)));
  const aes = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(b64decode(bundle.iv)),
      additionalData: toArrayBuffer(new TextEncoder().encode(RECOVERY_AAD)),
    },
    aes,
    toArrayBuffer(b64decode(bundle.data)),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as RecoveryPayload;
}

describe('cerrar sesión sin perder registros', () => {
  it('sin conexión y con pendientes bloquea el equipo y no borra nada', async () => {
    const { store, server, auth, session } = await setup();
    server.offline = true;
    await store.create('vehicle', { plate: 'AB1234' });

    const result = await session.requestLogout();
    expect(result).toEqual({ outcome: 'locked', pending: 1 });
    expect(session.state).toMatchObject({ kind: 'locked', reason: 'pending-at-logout', pending: 1 });
    expect(store.isUnlocked).toBe(false);
    expect(auth.logout).not.toHaveBeenCalled();

    await store.unlock(PIN);
    expect(await store.list('vehicle')).toHaveLength(1);
    expect(await store.pendingCount()).toBe(1);
  });

  it('con conexión sincroniza primero y solo entonces borra los datos locales', async () => {
    const { store, auth, session } = await setup();
    await store.create('vehicle', { plate: 'AB1234' });
    expect(await session.requestLogout()).toEqual({ outcome: 'done' });
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(session.state.kind).toBe('logged-out');
    expect(await store.hasVault()).toBe(false);
  });
});

describe('tiempo máximo sin verificar en línea', () => {
  it('pasado el plazo exige reconectar, sin tocar los datos', async () => {
    const { store, session, auth, autoSync, advance, now } = await setup();
    await store.create('vehicle', { plate: 'AB1234' });
    await store.setMeta('lastOnlineVerifiedAt', now());
    store.lock();
    advance(8 * DAY);

    await expect(session.unlock(PIN)).rejects.toBeInstanceOf(GraceExpiredError);
    expect(session.state).toMatchObject({ kind: 'locked', reason: 'grace-expired', pending: 1 });
    expect(store.isUnlocked).toBe(false);

    await session.loginOnline('usuario@correo.cl', 'clave');
    expect(auth.login).toHaveBeenCalledWith(expect.objectContaining({ deviceId: store.deviceId }));
    await session.unlock(PIN);
    expect(session.state).toEqual({ kind: 'active', needsOnlineLogin: false });
    expect(autoSync.started).toBe(true);
    expect(await store.list('vehicle')).toHaveLength(1);
  });

  it('dentro del plazo se puede trabajar sin conexión', async () => {
    const { store, session, advance, now } = await setup();
    await store.setMeta('lastOnlineVerifiedAt', now());
    store.lock();
    advance(3 * DAY);
    await session.unlock(PIN);
    expect(session.state.kind).toBe('active');
  });

  it('una sincronización exitosa renueva la marca de verificación', async () => {
    const { store, autoSync, advance, now } = await setup();
    advance(DAY);
    autoSync.emit({
      state: 'idle',
      failures: 0,
      lastReport: { status: 'ok', applied: 0, duplicates: 0, conflicts: 0, rejected: 0, pulled: 0 },
    });
    await waitFor(async () => (await store.getMeta<number>('lastOnlineVerifiedAt')) === now());
  });

  it('al iniciar sesión en línea se guarda la llave de recuperación de la organización', async () => {
    const { store, session } = await setup({ fetchRecoveryKey: async () => 'LLAVE-PUBLICA' });
    await session.loginOnline('usuario@correo.cl', 'clave');
    expect(await store.getMeta('recoveryPublicKey')).toBe('LLAVE-PUBLICA');
  });
});

describe('equipo revocado: cuarentena y recuperación', () => {
  it('conserva todo, permite exportar un paquete cifrado y solo entonces borrar', async () => {
    const keys = await rsaKeys();
    const { store, autoSync, session } = await setup();
    await store.setMeta('recoveryPublicKey', keys.spkiBase64);
    const rec = await store.create('vehicle', { plate: 'AB1234', brand: 'Toyota' });
    await store.update('vehicle', rec.id, { model: 'Yaris' });

    autoSync.emit({ state: 'session-lost', code: 'DEVICE_REVOKED', failures: 0 });
    await waitFor(() => session.state.kind === 'quarantine');
    expect(session.state).toMatchObject({ kind: 'quarantine', reason: 'DEVICE_REVOKED', pending: 1 });
    expect(store.isUnlocked).toBe(false);

    // sin paquete exportado no se puede borrar
    await expect(session.finishQuarantine()).rejects.toBeInstanceOf(PendingOperationsError);
    await store.unlock(PIN);
    expect(await store.list('vehicle')).toHaveLength(1);
    store.lock();

    const bundleJson = await session.exportRecovery(PIN);
    expect(bundleJson).not.toContain('AB1234'); // viaja cifrado
    const payload = await openBundle(bundleJson, keys.pkcs8);
    expect(payload).toMatchObject({ v: 1, orgId: ORG, userId: USER, deviceId: store.deviceId });
    expect(payload.ops).toHaveLength(1);
    expect(payload.ops[0]).toMatchObject({
      kind: 'create',
      entityId: rec.id,
      patch: { plate: 'AB1234', brand: 'Toyota', model: 'Yaris' },
    });

    await session.finishQuarantine();
    expect(session.state.kind).toBe('logged-out');
    expect(await store.hasVault()).toBe(false);
  });

  it('lo que se agregue después de exportar impide borrar hasta exportar de nuevo', async () => {
    const keys = await rsaKeys();
    const { store, session } = await setup();
    await store.setMeta('recoveryPublicKey', keys.spkiBase64);
    await store.create('vehicle', { plate: 'AAA111' });
    await session.exportRecovery(PIN);

    await store.unlock(PIN);
    await store.create('vehicle', { plate: 'BBB222' });
    store.lock();
    await expect(session.finishQuarantine()).rejects.toBeInstanceOf(PendingOperationsError);

    await session.exportRecovery(PIN);
    await session.finishQuarantine();
    expect(await store.hasVault()).toBe(false);
  });

  it('sin la llave de la organización no se puede exportar', async () => {
    const { store, session } = await setup();
    await store.create('vehicle', { plate: 'AB1234' });
    await expect(session.exportRecovery(PIN)).rejects.toBeInstanceOf(NoRecoveryKeyError);
  });

  it('una sesión vencida (no revocada) solo pide volver a iniciar sesión, sin cuarentena', async () => {
    const { store, autoSync, session } = await setup();
    await store.create('vehicle', { plate: 'AB1234' });
    autoSync.emit({ state: 'session-lost', code: 'TOKEN_EXPIRED', failures: 0 });
    await waitFor(() => session.state.kind === 'active');
    expect(session.state).toEqual({ kind: 'active', needsOnlineLogin: true });
    expect(store.isUnlocked).toBe(true);
  });
});

describe('bloqueo por inactividad', () => {
  it('bloquea el equipo cuando vence el tiempo y reinicia el reloj con cada interacción', async () => {
    let fire: (() => void) | undefined;
    const clear = jest.fn();
    const { store, session } = await setup({
      inactivityMs: 5 * 60_000,
      timers: {
        set: (fn: () => void) => {
          fire = fn;
          return 1;
        },
        clear,
      },
    });
    await store.create('vehicle', { plate: 'AB1234' });
    await session.unlock(PIN);
    expect(fire).toBeDefined();

    session.touch();
    expect(clear).toHaveBeenCalled();

    (fire as () => void)();
    await waitFor(() => session.state.kind === 'locked');
    expect(session.state).toMatchObject({ kind: 'locked', reason: 'inactivity', pending: 1 });
    expect(store.isUnlocked).toBe(false);
  });
});
