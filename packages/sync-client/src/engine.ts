import { NetworkError } from './errors';
import type { ConflictResolution, PushResponse } from './protocol';
import type { LocalStore } from './store';
import type { SyncReport } from './types';
import type { SyncTransport } from './transport';

export interface EngineOptions {
  batchSize?: number;
  pullLimit?: number;
  /** Exclusión entre pestañas. Por defecto usa Web Locks si el navegador los tiene. */
  runExclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Motor de sincronización: primero envía lo pendiente (push), después recibe lo nuevo (pull).
 * Nada se descarta: ante cualquier fallo, las operaciones se conservan y se reintentan.
 */
export class SyncEngine {
  private running: Promise<SyncReport> | null = null;
  private readonly batchSize: number;
  private readonly pullLimit: number;
  private readonly runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    private readonly store: LocalStore,
    private readonly transport: SyncTransport,
    options: EngineOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.pullLimit = options.pullLimit ?? 200;
    this.runExclusive = options.runExclusive ?? defaultExclusive(`sgv-sync-${store.deviceId}`);
  }

  /** Si ya hay una sincronización en curso se comparte su resultado en vez de lanzar otra. */
  syncOnce(): Promise<SyncReport> {
    if (!this.running) {
      this.running = this.runExclusive(() => this.run()).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(): Promise<SyncReport> {
    const report: SyncReport = { status: 'ok', applied: 0, duplicates: 0, conflicts: 0, rejected: 0, pulled: 0 };
    await this.store.recoverInFlight();
    try {
      // 1. Enviar lo pendiente, un cambio por registro en cada ronda.
      for (;;) {
        const batch = await this.store.nextBatch(this.batchSize);
        if (batch.length === 0) break;
        await this.store.markInFlight(batch);
        let response: PushResponse;
        try {
          response = await this.transport.push(batch.map((b) => b.op));
        } catch (err) {
          await this.store.revertInFlight(batch);
          throw err;
        }
        const applied = await this.store.applyPushResults(batch, response.results);
        report.applied += applied.applied;
        report.duplicates += applied.duplicates;
        report.conflicts += applied.conflicts;
        report.rejected += applied.rejected;
      }

      // 2. Recibir lo nuevo.
      for (;;) {
        const since = await this.store.getCursor();
        const pending = await this.store.pendingCount();
        const page = await this.transport.pull({ sinceSeq: since, limit: this.pullLimit, pendingOpsCount: pending });
        report.pulled += await this.store.applyPullChanges(page);
        if (!page.hasMore) break;
      }

      // 3. Mantener al día la lista de conflictos abiertos.
      if ((await this.store.stats()).conflicts > 0) await this.refreshConflicts();
    } catch (err) {
      if (err instanceof NetworkError) return { ...report, status: 'offline' };
      throw err;
    }
    return report;
  }

  async refreshConflicts(): Promise<void> {
    await this.store.cacheConflicts(await this.transport.listConflicts());
  }

  /** Resuelve un conflicto en el servidor y refleja el resultado en el dispositivo. */
  async resolveConflict(
    conflictId: string,
    resolution: ConflictResolution,
    patch?: Record<string, unknown>,
  ): Promise<void> {
    const conflict = await this.store.getConflict(conflictId);
    if (!conflict) throw new Error('Conflicto desconocido: sincroniza para actualizar la lista');
    const result = await this.transport.resolveConflict(conflictId, resolution, patch);
    await this.store.applyResolution(conflict, resolution, result.record);
  }
}

function defaultExclusive(name: string): <T>(fn: () => Promise<T>) => Promise<T> {
  const nav = (globalThis as unknown as {
    navigator?: { locks?: { request: <T>(n: string, cb: () => Promise<T>) => Promise<T> } };
  }).navigator;
  if (nav?.locks) {
    const locks = nav.locks;
    return <T>(fn: () => Promise<T>) => locks.request(name, fn);
  }
  return (fn) => fn();
}
