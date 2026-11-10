import { createVault, decryptJson, DEFAULT_KDF, encryptJson, KdfOptions, unlockVault, VaultData } from './crypto';
import { SgvDb } from './local-db';
import {
  PendingOperationsError,
  ProtocolError,
  ReauthRequiredError,
  UnlockThrottledError,
  VaultLockedError,
  WrongSecretError,
} from './errors';
import type { OperationKind, OperationResult, PullResponse, ServerConflict } from './protocol';
import type { RecoveryOp } from './recovery';
import type {
  BatchItem,
  LocalRecord,
  OpPlain,
  OpStatus,
  OutboxRow,
  RecordPlain,
  RecordRow,
  ServerMeta,
  StoreStats,
  SyncStatus,
} from './types';

export interface StoreOptions {
  orgId: string;
  userId: string;
  /** Distingue instalaciones que comparten almacenamiento (por ejemplo, pruebas con varios dispositivos). */
  namespace?: string;
  kdf?: Partial<KdfOptions>;
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof IDBKeyRange;
  now?: () => number;
}

const MAX_FAILED_UNLOCKS = 10;
const SYSTEM_KEYS = [
  'id',
  'version',
  'serverSeq',
  'createdAt',
  'updatedAt',
  'clientCreatedAt',
  'clientUpdatedAt',
  'createdBy',
  'updatedBy',
  'createdDeviceId',
  'updatedDeviceId',
  'deletedAt',
  'deleteReason',
];
const UNCONFIRMED: OpStatus[] = ['pendiente', 'enviada', 'conflicto', 'rechazada'];

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

function statusFor(ops: Array<{ status: OpStatus }>): SyncStatus {
  if (ops.some((o) => o.status === 'conflicto' || o.status === 'rechazada')) return 'conflicto';
  if (ops.some((o) => o.status === 'pendiente' || o.status === 'enviada')) return 'pendiente';
  return 'sincronizado';
}

function toServerMeta(record: Record<string, unknown>): ServerMeta {
  const str = (k: string): string | null => (typeof record[k] === 'string' ? (record[k] as string) : null);
  return {
    version: Number(record.version),
    serverSeq: Number(record.serverSeq),
    createdAt: str('createdAt'),
    updatedAt: str('updatedAt'),
    createdBy: str('createdBy'),
    updatedBy: str('updatedBy'),
    createdDeviceId: str('createdDeviceId'),
    updatedDeviceId: str('updatedDeviceId'),
    deletedAt: str('deletedAt'),
    deleteReason: str('deleteReason'),
  };
}

function businessFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!SYSTEM_KEYS.includes(k)) out[k] = v;
  }
  return out;
}

export class LocalStore {
  private dek: CryptoKey | null = null;
  private readonly mutex = new Mutex();
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  private constructor(
    private readonly db: SgvDb,
    readonly deviceId: string,
    private readonly opts: StoreOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  static async open(opts: StoreOptions): Promise<LocalStore> {
    const name = `sgv_${opts.orgId}_${opts.userId}${opts.namespace ? `_${opts.namespace}` : ''}`;
    const db = new SgvDb(name, { indexedDB: opts.indexedDB, IDBKeyRange: opts.IDBKeyRange });
    await db.open();
    let device = await db.meta.get('deviceId');
    if (!device) {
      device = { key: 'deviceId', value: globalThis.crypto.randomUUID() };
      await db.meta.put(device);
    }
    return new LocalStore(db, device.value as string, opts);
  }

  close(): void {
    this.dek = null;
    this.db.close();
  }

  // ============================================================ bóveda y claves
  get isUnlocked(): boolean {
    return this.dek !== null;
  }

  async hasVault(): Promise<boolean> {
    return (await this.db.meta.get('vault')) !== undefined;
  }

  async initVault(secret: string): Promise<void> {
    if (await this.hasVault()) throw new Error('Ya existe una bóveda en este dispositivo');
    const { vault, dek } = await createVault(secret, { ...DEFAULT_KDF, ...this.opts.kdf });
    await this.db.meta.put({ key: 'vault', value: vault });
    this.dek = dek;
  }

  async unlock(secret: string): Promise<void> {
    const vault = (await this.db.meta.get('vault'))?.value as VaultData | undefined;
    if (!vault) throw new Error('No hay bóveda en este dispositivo');
    const state = ((await this.db.meta.get('unlockState'))?.value ?? { failed: 0, lockedUntil: 0 }) as {
      failed: number;
      lockedUntil: number;
    };
    if (state.failed >= MAX_FAILED_UNLOCKS) throw new ReauthRequiredError();
    const now = this.now();
    if (state.lockedUntil > now) throw new UnlockThrottledError(state.lockedUntil - now);
    try {
      this.dek = await unlockVault(vault, secret);
      await this.db.meta.put({ key: 'unlockState', value: { failed: 0, lockedUntil: 0 } });
    } catch (err) {
      if (err instanceof WrongSecretError) {
        const failed = state.failed + 1;
        const delay = failed >= 3 ? Math.min(1000 * 2 ** (failed - 3), 300_000) : 0;
        await this.db.meta.put({ key: 'unlockState', value: { failed, lockedUntil: now + delay } });
      }
      throw err;
    }
  }

  /** Se invoca tras un inicio de sesión en línea exitoso. */
  async resetUnlockAttempts(): Promise<void> {
    await this.db.meta.put({ key: 'unlockState', value: { failed: 0, lockedUntil: 0 } });
  }

  /** Saca la clave de memoria: los datos siguen en el dispositivo, cifrados. */
  lock(): void {
    this.dek = null;
  }

  private requireDek(): CryptoKey {
    if (!this.dek) throw new VaultLockedError();
    return this.dek;
  }

  private recAad(entityType: string, id: string): string {
    return `rec:${entityType}:${id}`;
  }

  private opAad(operationId: string): string {
    return `op:${operationId}`;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Avisa cuando el usuario guarda algo (la sincronización automática lo usa para enviar pronto). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async write<T>(fn: () => Promise<T>): Promise<T> {
    const result = await this.mutex.run(fn);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // un oyente defectuoso no debe afectar a quien guarda
      }
    }
    return result;
  }

  /** Valores sueltos del dispositivo (marcas de tiempo, llave pública de recuperación). Nada sensible. */
  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.db.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.meta.put({ key, value });
  }

  // ============================================================ lecturas
  private async decryptRecord(row: RecordRow): Promise<RecordPlain> {
    return decryptJson<RecordPlain>(this.requireDek(), row.enc, this.recAad(row.entityType, row.id));
  }

  private toLocal(row: RecordRow, plain: RecordPlain): LocalRecord {
    return {
      entityType: row.entityType,
      id: row.id,
      fields: plain.fields,
      server: plain.server,
      syncStatus: row.syncStatus,
      deleted: row.deleted === 1,
      dirtyFields: plain.dirtyFields,
      lastError: plain.lastError,
      conflictId: plain.conflictId,
      createdAtLocal: plain.createdAtLocal,
      updatedAtLocal: plain.updatedAtLocal,
    };
  }

  async get(entityType: string, id: string): Promise<LocalRecord | undefined> {
    const row = await this.db.records.get([entityType, id]);
    return row ? this.toLocal(row, await this.decryptRecord(row)) : undefined;
  }

  async list(entityType: string, options: { includeDeleted?: boolean } = {}): Promise<LocalRecord[]> {
    const rows = await this.db.records.where('entityType').equals(entityType).toArray();
    const out: LocalRecord[] = [];
    for (const row of rows) {
      if (row.deleted === 1 && !options.includeDeleted) continue;
      out.push(this.toLocal(row, await this.decryptRecord(row)));
    }
    return out;
  }

  async stats(): Promise<StoreStats> {
    const ops = await this.db.outbox.where('status').anyOf(UNCONFIRMED).toArray();
    return {
      pending: ops.length,
      conflicts: ops.filter((o) => o.status === 'conflicto' || o.status === 'rechazada').length,
    };
  }

  async pendingCount(): Promise<number> {
    return (await this.stats()).pending;
  }

  // ============================================================ escrituras del usuario
  /**
   * Crea un registro localmente. Si se reutilizan los mismos ids (por ejemplo, un doble toque en
   * "Guardar") no se crea una segunda operación: se devuelve el mismo registro.
   */
  async create(
    entityType: string,
    fields: Record<string, unknown>,
    ids: { entityId?: string; operationId?: string } = {},
  ): Promise<LocalRecord> {
    return this.write(async () => {
      const dek = this.requireDek();
      const entityId = ids.entityId ?? globalThis.crypto.randomUUID();
      const operationId = ids.operationId ?? globalThis.crypto.randomUUID();

      if (await this.db.outbox.get(operationId)) {
        const existing = await this.db.records.get([entityType, entityId]);
        if (existing) return this.toLocal(existing, await this.decryptRecord(existing));
      }
      if (await this.db.records.get([entityType, entityId])) {
        throw new Error('Ya existe un registro con ese id');
      }

      const at = this.nowIso();
      const plain: RecordPlain = {
        fields: { ...fields },
        server: null,
        baseFields: null,
        dirtyFields: Object.keys(fields),
        lastError: null,
        conflictId: null,
        createdAtLocal: at,
        updatedAtLocal: at,
      };
      const opPlain: OpPlain = { patch: { ...fields }, baseVersion: null, baseFromPrevious: false, clientUpdatedAt: at };
      const recEnc = await encryptJson(dek, plain, this.recAad(entityType, entityId));
      const opEnc = await encryptJson(dek, opPlain, this.opAad(operationId));
      const row: RecordRow = { entityType, id: entityId, syncStatus: 'pendiente', deleted: 0, enc: recEnc };

      await this.db.transaction('rw', this.db.records, this.db.outbox, this.db.meta, async () => {
        const deviceSeq = await this.nextDeviceSeq();
        await this.db.records.put(row);
        await this.db.outbox.put({
          operationId,
          deviceSeq,
          status: 'pendiente',
          entityType,
          entityId,
          kind: 'create',
          attempts: 0,
          enc: opEnc,
        });
      });
      return this.toLocal(row, plain);
    });
  }

  async update(entityType: string, id: string, patch: Record<string, unknown>): Promise<LocalRecord> {
    return this.write(async () => {
      const dek = this.requireDek();
      const row = await this.db.records.get([entityType, id]);
      if (!row) throw new Error('El registro no existe');
      if (row.deleted === 1) throw new Error('El registro está eliminado');
      const plain = await this.decryptRecord(row);
      const unconfirmed = await this.unconfirmedOps(entityType, id);
      const last = unconfirmed[unconfirmed.length - 1];
      const at = this.nowIso();

      plain.fields = { ...plain.fields, ...patch };
      plain.dirtyFields = Array.from(new Set([...plain.dirtyFields, ...Object.keys(patch)]));
      plain.updatedAtLocal = at;

      let opPut: OutboxRow | null = null;
      let newOp: OutboxRow | null = null;
      if (last && last.status === 'pendiente' && (last.kind === 'create' || last.kind === 'update')) {
        // Aún no salió: se acumula en la misma operación (un solo cambio con la versión base original).
        const opPlain = await decryptJson<OpPlain>(dek, last.enc, this.opAad(last.operationId));
        opPlain.patch = { ...opPlain.patch, ...patch };
        opPlain.clientUpdatedAt = at;
        opPut = { ...last, enc: await encryptJson(dek, opPlain, this.opAad(last.operationId)) };
      } else {
        const baseFromPrevious = unconfirmed.length > 0;
        const baseVersion = baseFromPrevious ? null : (plain.server?.version ?? null);
        if (!baseFromPrevious && baseVersion === null) throw new Error('El registro aún no tiene versión del servidor');
        const operationId = globalThis.crypto.randomUUID();
        const opPlain: OpPlain = { patch: { ...patch }, baseVersion, baseFromPrevious, clientUpdatedAt: at };
        newOp = {
          operationId,
          deviceSeq: 0,
          status: 'pendiente',
          entityType,
          entityId: id,
          kind: 'update',
          attempts: 0,
          enc: await encryptJson(dek, opPlain, this.opAad(operationId)),
        };
      }

      const statuses = unconfirmed.map((o) => ({ status: o.status }));
      if (newOp) statuses.push({ status: 'pendiente' });
      const newRow: RecordRow = {
        ...row,
        syncStatus: statusFor(statuses),
        enc: await encryptJson(dek, plain, this.recAad(entityType, id)),
      };

      await this.db.transaction('rw', this.db.records, this.db.outbox, this.db.meta, async () => {
        await this.db.records.put(newRow);
        if (opPut) await this.db.outbox.put(opPut);
        if (newOp) {
          newOp.deviceSeq = await this.nextDeviceSeq();
          await this.db.outbox.put(newOp);
        }
      });
      return this.toLocal(newRow, plain);
    });
  }

  /** Eliminación lógica. Si el servidor nunca vio el registro, simplemente desaparece sin dejar rastro. */
  async remove(entityType: string, id: string, options: { reason?: string } = {}): Promise<void> {
    return this.write(async () => {
      const dek = this.requireDek();
      const row = await this.db.records.get([entityType, id]);
      if (!row) return;
      const plain = await this.decryptRecord(row);
      const unconfirmed = await this.unconfirmedOps(entityType, id);
      const createOp = unconfirmed.find((o) => o.kind === 'create');

      if (createOp) {
        if (createOp.status === 'enviada') throw new Error('Sincronización en curso: reintenta en unos segundos');
        await this.db.transaction('rw', this.db.records, this.db.outbox, async () => {
          await this.db.records.delete([entityType, id]);
          await this.db.outbox.bulkDelete(unconfirmed.map((o) => o.operationId));
        });
        return;
      }

      // Los cambios pendientes de edición ya no hacen falta: se reemplazan por la baja.
      const droppable = unconfirmed.filter((o) => o.status === 'pendiente' && o.kind === 'update');
      const remaining = unconfirmed.filter((o) => !droppable.includes(o));
      const baseFromPrevious = remaining.length > 0;
      const baseVersion = baseFromPrevious ? null : (plain.server?.version ?? null);
      if (!baseFromPrevious && baseVersion === null) throw new Error('El registro aún no tiene versión del servidor');

      const at = this.nowIso();
      const operationId = globalThis.crypto.randomUUID();
      const opPlain: OpPlain = {
        patch: options.reason ? { deleteReason: options.reason } : {},
        baseVersion,
        baseFromPrevious,
        clientUpdatedAt: at,
      };
      plain.updatedAtLocal = at;
      const newRow: RecordRow = {
        ...row,
        deleted: 1,
        syncStatus: statusFor([...remaining, { status: 'pendiente' }]),
        enc: await encryptJson(dek, plain, this.recAad(entityType, id)),
      };
      const opEnc = await encryptJson(dek, opPlain, this.opAad(operationId));
      await this.db.transaction('rw', this.db.records, this.db.outbox, this.db.meta, async () => {
        await this.db.outbox.bulkDelete(droppable.map((o) => o.operationId));
        const deviceSeq = await this.nextDeviceSeq();
        await this.db.records.put(newRow);
        await this.db.outbox.put({
          operationId,
          deviceSeq,
          status: 'pendiente',
          entityType,
          entityId: id,
          kind: 'delete',
          attempts: 0,
          enc: opEnc,
        });
      });
    });
  }

  private async nextDeviceSeq(): Promise<number> {
    const current = ((await this.db.meta.get('deviceSeq'))?.value as number | undefined) ?? 0;
    await this.db.meta.put({ key: 'deviceSeq', value: current + 1 });
    return current + 1;
  }

  private async unconfirmedOps(entityType: string, entityId: string): Promise<OutboxRow[]> {
    const ops = await this.db.outbox.where('[entityType+entityId]').equals([entityType, entityId]).toArray();
    return ops.filter((o) => o.status !== 'confirmada').sort((a, b) => a.deviceSeq - b.deviceSeq);
  }

  // ============================================================ para el motor de sincronización
  /** Tras un cierre inesperado: lo que estaba "en vuelo" vuelve a la cola (reenviar es seguro: idempotente). */
  async recoverInFlight(): Promise<number> {
    return this.db.outbox.where('status').equals('enviada').modify({ status: 'pendiente' });
  }

  async nextBatch(max: number): Promise<BatchItem[]> {
    const dek = this.requireDek();
    const pending = (await this.db.outbox.where('status').equals('pendiente').toArray()).sort(
      (a, b) => a.deviceSeq - b.deviceSeq,
    );
    const blockedRows = await this.db.outbox.where('status').anyOf(['conflicto', 'rechazada', 'enviada']).toArray();
    const blocked = new Set(blockedRows.map((o) => `${o.entityType}:${o.entityId}`));
    const seen = new Set<string>();
    const batch: BatchItem[] = [];

    for (const row of pending) {
      if (batch.length >= max) break;
      const key = `${row.entityType}:${row.entityId}`;
      // Un solo cambio por registro en cada envío: el siguiente necesita la versión que devuelva el servidor.
      if (blocked.has(key) || seen.has(key)) continue;
      seen.add(key);
      const opPlain = await decryptJson<OpPlain>(dek, row.enc, this.opAad(row.operationId));
      let baseVersion = opPlain.baseVersion;
      if (opPlain.baseFromPrevious) {
        const rec = await this.db.records.get([row.entityType, row.entityId]);
        baseVersion = rec ? ((await this.decryptRecord(rec)).server?.version ?? null) : null;
      }
      if (row.kind !== 'create' && baseVersion === null) {
        await this.db.outbox.update(row.operationId, { status: 'rechazada' });
        continue;
      }
      batch.push({
        operationId: row.operationId,
        entityType: row.entityType,
        entityId: row.entityId,
        kind: row.kind,
        op: {
          operationId: row.operationId,
          entityType: row.entityType,
          entityId: row.entityId,
          kind: row.kind,
          baseVersion: row.kind === 'create' ? null : baseVersion,
          patch: opPlain.patch,
          clientUpdatedAt: opPlain.clientUpdatedAt,
          deviceSeq: row.deviceSeq,
        },
      });
    }
    return batch;
  }

  async markInFlight(batch: BatchItem[]): Promise<void> {
    await this.db.transaction('rw', this.db.outbox, async () => {
      for (const item of batch) {
        const row = await this.db.outbox.get(item.operationId);
        if (row) await this.db.outbox.update(item.operationId, { status: 'enviada', attempts: row.attempts + 1 });
      }
    });
  }

  async revertInFlight(batch: BatchItem[]): Promise<void> {
    await this.db.transaction('rw', this.db.outbox, async () => {
      for (const item of batch) {
        const row = await this.db.outbox.get(item.operationId);
        if (row && row.status === 'enviada') await this.db.outbox.update(item.operationId, { status: 'pendiente' });
      }
    });
  }

  async applyPushResults(
    batch: BatchItem[],
    results: OperationResult[],
  ): Promise<{ applied: number; duplicates: number; conflicts: number; rejected: number }> {
    return this.mutex.run(async () => {
      const dek = this.requireDek();
      const byId = new Map(results.map((r) => [r.operationId, r]));
      const report = { applied: 0, duplicates: 0, conflicts: 0, rejected: 0 };
      const recordPuts: RecordRow[] = [];
      const opPuts: OutboxRow[] = [];
      let missing = 0;

      for (const item of batch) {
        const opRow = await this.db.outbox.get(item.operationId);
        if (!opRow) continue;
        const result = byId.get(item.operationId);
        if (!result) {
          opPuts.push({ ...opRow, status: 'pendiente' });
          missing++;
          continue;
        }
        const recRow = await this.db.records.get([item.entityType, item.entityId]);
        const opPlain = await decryptJson<OpPlain>(dek, opRow.enc, this.opAad(opRow.operationId));
        const others = (await this.unconfirmedOps(item.entityType, item.entityId)).filter(
          (o) => o.operationId !== opRow.operationId,
        );
        const plain = recRow ? await this.decryptRecord(recRow) : null;

        let newStatus: OpStatus;
        if (result.result === 'aplicada' || result.result === 'duplicada') {
          newStatus = 'confirmada';
          if (result.result === 'aplicada') report.applied++;
          else report.duplicates++;
          if (plain) {
            plain.server = {
              ...(plain.server ?? {
                createdAt: null,
                updatedAt: null,
                createdBy: null,
                updatedBy: null,
                createdDeviceId: null,
                updatedDeviceId: null,
                deletedAt: null,
                deleteReason: null,
              }),
              version: result.version,
              serverSeq: result.serverSeq,
            };
            if (opRow.kind !== 'delete') plain.baseFields = { ...(plain.baseFields ?? {}), ...opPlain.patch };
            plain.lastError = null;
            plain.conflictId = null;
          }
        } else if (result.result === 'conflicto') {
          newStatus = 'conflicto';
          report.conflicts++;
          opPlain.conflictId = result.conflictId;
          opPlain.conflictType = result.conflictType;
          opPlain.conflictFields = result.conflictingFields;
          if (plain) {
            plain.conflictId = result.conflictId;
            plain.lastError = `conflicto:${result.conflictType}`;
          }
        } else {
          newStatus = 'rechazada';
          report.rejected++;
          opPlain.reason = result.reason;
          if (plain) plain.lastError = result.reason;
        }

        opPuts.push({
          ...opRow,
          status: newStatus,
          confirmedAt: newStatus === 'confirmada' ? this.now() : undefined,
          enc: await encryptJson(dek, opPlain, this.opAad(opRow.operationId)),
        });
        if (recRow && plain) {
          const after = [...others, { status: newStatus }];
          if (newStatus === 'confirmada') {
            const dirty = new Set<string>();
            for (const o of others) {
              const p = await decryptJson<OpPlain>(dek, o.enc, this.opAad(o.operationId));
              Object.keys(p.patch).forEach((k) => dirty.add(k));
            }
            plain.dirtyFields = Array.from(dirty);
          }
          recordPuts.push({
            ...recRow,
            syncStatus: statusFor(after),
            enc: await encryptJson(dek, plain, this.recAad(recRow.entityType, recRow.id)),
          });
        }
      }

      await this.db.transaction('rw', this.db.records, this.db.outbox, async () => {
        if (recordPuts.length) await this.db.records.bulkPut(recordPuts);
        if (opPuts.length) await this.db.outbox.bulkPut(opPuts);
      });
      if (missing > 0) throw new ProtocolError(`El servidor no respondió ${missing} operación(es); quedan en cola`);
      return report;
    });
  }

  async getCursor(): Promise<number> {
    return ((await this.db.meta.get('lastPulledSeq'))?.value as number | undefined) ?? 0;
  }

  /** Aplica una página de cambios del servidor junto con el avance del cursor, en una sola transacción. */
  async applyPullChanges(response: PullResponse): Promise<number> {
    return this.mutex.run(async () => {
      const dek = this.requireDek();
      const puts: RecordRow[] = [];
      for (const change of response.changes) {
        const existing = await this.db.records.get([change.entityType, change.entityId]);
        const merged = await this.mergeServerRecord(dek, existing, change.entityType, change.record);
        if (merged) puts.push(merged);
      }
      await this.db.transaction('rw', this.db.records, this.db.meta, async () => {
        if (puts.length) await this.db.records.bulkPut(puts);
        const cursor = await this.getCursor();
        if (response.nextSeq > cursor) await this.db.meta.put({ key: 'lastPulledSeq', value: response.nextSeq });
      });
      return response.changes.length;
    });
  }

  /**
   * Incorpora un registro del servidor. Si hay trabajo local sin confirmar sobre él, no se pisa:
   * solo se actualiza lo que se sabe del servidor.
   */
  private async mergeServerRecord(
    dek: CryptoKey,
    existing: RecordRow | undefined,
    entityType: string,
    record: Record<string, unknown>,
  ): Promise<RecordRow | null> {
    const id = String(record.id);
    const server = toServerMeta(record);
    const fields = businessFields(record);
    const deleted: 0 | 1 = server.deletedAt ? 1 : 0;
    const at = this.nowIso();

    if (!existing) {
      const plain: RecordPlain = {
        fields,
        server,
        baseFields: fields,
        dirtyFields: [],
        lastError: null,
        conflictId: null,
        createdAtLocal: at,
        updatedAtLocal: at,
      };
      return {
        entityType,
        id,
        syncStatus: 'sincronizado',
        deleted,
        enc: await encryptJson(dek, plain, this.recAad(entityType, id)),
      };
    }

    const plain = await this.decryptRecord(existing);
    if (plain.server && plain.server.version > server.version) return null; // dato más viejo que el que ya tenemos
    const unconfirmed = await this.unconfirmedOps(entityType, id);
    plain.server = server;
    plain.baseFields = fields;
    plain.updatedAtLocal = at;
    if (unconfirmed.length === 0) {
      plain.fields = fields;
      plain.dirtyFields = [];
      plain.lastError = null;
      plain.conflictId = null;
    }
    return {
      ...existing,
      deleted: unconfirmed.length === 0 ? deleted : existing.deleted,
      syncStatus: statusFor(unconfirmed),
      enc: await encryptJson(dek, plain, this.recAad(entityType, id)),
    };
  }

  // ============================================================ conflictos
  async cacheConflicts(list: ServerConflict[]): Promise<void> {
    const dek = this.requireDek();
    const rows = await Promise.all(
      list.map(async (c) => ({ id: c.id, status: c.status, enc: await encryptJson(dek, c, `conflict:${c.id}`) })),
    );
    await this.db.transaction('rw', this.db.conflicts, async () => {
      await this.db.conflicts.bulkPut(rows);
    });
  }

  async listConflicts(): Promise<ServerConflict[]> {
    const dek = this.requireDek();
    const rows = await this.db.conflicts.where('status').equals('abierto').toArray();
    return Promise.all(rows.map((r) => decryptJson<ServerConflict>(dek, r.enc, `conflict:${r.id}`)));
  }

  async getConflict(id: string): Promise<ServerConflict | undefined> {
    const dek = this.requireDek();
    const row = await this.db.conflicts.get(id);
    return row ? decryptJson<ServerConflict>(dek, row.enc, `conflict:${id}`) : undefined;
  }

  /**
   * Efectos locales de resolver un conflicto. "servidor" descarta lo local de ese registro;
   * "cliente" y "manual" ya fueron aplicados por el servidor: se incorpora su resultado.
   */
  async applyResolution(
    conflict: ServerConflict,
    resolution: 'servidor' | 'cliente' | 'manual',
    serverRecord: Record<string, unknown> | null,
  ): Promise<void> {
    return this.mutex.run(async () => {
      const dek = this.requireDek();
      const { entityType, entityId } = conflict;
      const unconfirmed = await this.unconfirmedOps(entityType, entityId);
      const existing = await this.db.records.get([entityType, entityId]);
      let recordPut: RecordRow | null = null;
      let recordDelete = false;
      const opDeletes: string[] = [];
      const opPuts: OutboxRow[] = [];

      if (resolution === 'servidor') {
        // Se descarta todo el trabajo local sobre este registro y se vuelve a lo que dice el servidor.
        opDeletes.push(...unconfirmed.map((o) => o.operationId));
        if (conflict.kind === 'create' && conflict.conflictType !== 'version') {
          // Duplicado o creación sin permiso: la versión local no debe existir.
          recordDelete = true;
          if (conflict.serverSnapshot) {
            // El registro que ya existía en el servidor se incorpora sin esperar al próximo pull.
            const snapId = String(conflict.serverSnapshot.id);
            if (!(await this.db.records.get([entityType, snapId]))) {
              recordPut = await this.mergeServerRecord(dek, undefined, entityType, conflict.serverSnapshot);
            }
          }
        } else if (existing) {
          // Se restaura lo último que se sabe del servidor (los pull mantienen baseFields al día).
          const plain = await this.decryptRecord(existing);
          if (plain.baseFields) {
            plain.fields = { ...plain.baseFields };
          } else if (conflict.serverSnapshot) {
            plain.fields = businessFields(conflict.serverSnapshot);
            plain.baseFields = { ...plain.fields };
            plain.server = toServerMeta(conflict.serverSnapshot);
          }
          plain.dirtyFields = [];
          plain.lastError = null;
          plain.conflictId = null;
          recordPut = {
            ...existing,
            deleted: plain.server?.deletedAt ? 1 : 0,
            syncStatus: 'sincronizado',
            enc: await encryptJson(dek, plain, this.recAad(entityType, entityId)),
          };
        } else if (conflict.serverSnapshot) {
          recordPut = await this.mergeServerRecord(dek, undefined, entityType, conflict.serverSnapshot);
        }
      } else {
        const op = unconfirmed.find((o) => o.operationId === conflict.operationId);
        if (op) opPuts.push({ ...op, status: 'confirmada', confirmedAt: this.now() });
        if (serverRecord) {
          const rest = unconfirmed.filter((o) => o.operationId !== conflict.operationId);
          const plainRow = await this.mergeServerRecord(dek, existing, entityType, serverRecord);
          if (plainRow) {
            const plain = await this.decryptRecord(plainRow);
            plain.conflictId = null;
            plain.lastError = null;
            if (rest.length === 0) {
              // Nada más pendiente: el registro local pasa a ser exactamente lo que dejó el servidor.
              plain.fields = businessFields(serverRecord);
              plain.dirtyFields = [];
            }
            recordPut = {
              ...plainRow,
              syncStatus: statusFor(rest),
              enc: await encryptJson(dek, plain, this.recAad(entityType, entityId)),
            };
          }
        }
      }

      const cached = await this.db.conflicts.get(conflict.id);
      await this.db.transaction('rw', this.db.records, this.db.outbox, this.db.conflicts, async () => {
        if (opDeletes.length) await this.db.outbox.bulkDelete(opDeletes);
        if (opPuts.length) await this.db.outbox.bulkPut(opPuts);
        if (recordDelete) await this.db.records.delete([entityType, entityId]);
        if (recordPut) await this.db.records.put(recordPut);
        if (cached) await this.db.conflicts.put({ ...cached, status: 'resuelto' });
      });
    });
  }

  /** El usuario decide descartar una operación rechazada o en conflicto sin resolverla en el servidor. */
  async discardOperation(operationId: string): Promise<void> {
    return this.mutex.run(async () => {
      const dek = this.requireDek();
      const op = await this.db.outbox.get(operationId);
      if (!op) return;
      const row = await this.db.records.get([op.entityType, op.entityId]);
      const rest = (await this.unconfirmedOps(op.entityType, op.entityId)).filter((o) => o.operationId !== operationId);
      let recordPut: RecordRow | null = null;
      let recordDelete = false;
      if (row) {
        if (op.kind === 'create') {
          recordDelete = true;
        } else {
          const plain = await this.decryptRecord(row);
          if (plain.baseFields) plain.fields = { ...plain.baseFields };
          plain.dirtyFields = [];
          plain.lastError = null;
          plain.conflictId = null;
          recordPut = {
            ...row,
            deleted: plain.server?.deletedAt ? 1 : 0,
            syncStatus: statusFor(rest),
            enc: await encryptJson(dek, plain, this.recAad(row.entityType, row.id)),
          };
        }
      }
      await this.db.transaction('rw', this.db.records, this.db.outbox, async () => {
        await this.db.outbox.delete(operationId);
        if (recordDelete) {
          await this.db.records.delete([op.entityType, op.entityId]);
          await this.db.outbox.bulkDelete(rest.map((o) => o.operationId));
        }
        if (recordPut) await this.db.records.put(recordPut);
      });
    });
  }

  async purgeConfirmed(olderThanMs: number): Promise<number> {
    const limit = this.now() - olderThanMs;
    const old = await this.db.outbox.where('status').equals('confirmada').filter((o) => (o.confirmedAt ?? 0) < limit).primaryKeys();
    await this.db.outbox.bulkDelete(old);
    return old.length;
  }

  // ============================================================ cierre de sesión seguro
  /** Solo permite borrar los datos locales si no queda nada sin confirmar en el servidor. */
  async safeWipe(): Promise<void> {
    const pending = await this.pendingCount();
    if (pending > 0) throw new PendingOperationsError(pending);
    await this.wipeAll();
  }

  private async wipeAll(): Promise<void> {
    this.dek = null;
    await this.db.transaction('rw', this.db.records, this.db.outbox, this.db.conflicts, this.db.meta, async () => {
      await this.db.records.clear();
      await this.db.outbox.clear();
      await this.db.conflicts.clear();
      await this.db.meta.clear();
    });
  }

  // ============================================================ recuperación
  /** Operaciones aún sin confirmar, descifradas, para armar un paquete de recuperación. */
  async collectRecoveryOps(): Promise<RecoveryOp[]> {
    const dek = this.requireDek();
    const rows = (await this.db.outbox.where('status').anyOf(UNCONFIRMED).toArray()).sort(
      (a, b) => a.deviceSeq - b.deviceSeq,
    );
    const out: RecoveryOp[] = [];
    for (const row of rows) {
      const plain = await decryptJson<OpPlain>(dek, row.enc, this.opAad(row.operationId));
      out.push({
        operationId: row.operationId,
        entityType: row.entityType,
        entityId: row.entityId,
        kind: row.kind as OperationKind,
        baseVersion: plain.baseVersion,
        baseFromPrevious: plain.baseFromPrevious,
        patch: plain.patch,
        clientUpdatedAt: plain.clientUpdatedAt,
        deviceSeq: row.deviceSeq,
        status: row.status as RecoveryOp['status'],
        conflictType: plain.conflictType,
        reason: plain.reason,
      });
    }
    return out;
  }

  /** Anota qué operaciones ya quedaron respaldadas en un paquete de recuperación exportado. */
  async markRecoveryExported(operationIds: string[]): Promise<void> {
    const previous = (await this.getMeta<string[]>('recoveryExportedOps')) ?? [];
    await this.setMeta('recoveryExportedOps', Array.from(new Set([...previous, ...operationIds])));
  }

  /**
   * Borrado tras una revocación: solo si cada operación pendiente ya fue exportada en un paquete de
   * recuperación. Si algo quedó fuera (por ejemplo, se agregó después de exportar), se rechaza.
   */
  async wipeAfterRecovery(): Promise<void> {
    const exported = new Set((await this.getMeta<string[]>('recoveryExportedOps')) ?? []);
    const pending = await this.db.outbox.where('status').anyOf(UNCONFIRMED).toArray();
    const missing = pending.filter((o) => !exported.has(o.operationId));
    if (missing.length > 0) throw new PendingOperationsError(missing.length);
    await this.wipeAll();
  }
}
