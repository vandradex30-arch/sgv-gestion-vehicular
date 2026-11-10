import { SessionError } from './errors';
import type { SyncEngine } from './engine';
import type { SyncReport } from './types';

export interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface DocumentLike extends EventTargetLike {
  visibilityState?: string;
}

export interface ChangeSource {
  onChange(listener: () => void): () => void;
}

export interface AutoSyncOptions {
  /** Sincronización periódica mientras la aplicación está abierta. */
  intervalMs?: number;
  /** Espera tras guardar, para agrupar varios guardados seguidos. */
  debounceMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
  windowLike?: EventTargetLike | null;
  documentLike?: DocumentLike | null;
}

export interface AutoSyncStatus {
  state: 'stopped' | 'idle' | 'syncing' | 'offline' | 'error' | 'session-lost';
  failures: number;
  lastReport?: SyncReport;
  error?: string;
  /** Código de la sesión caída (por ejemplo DEVICE_REVOKED). */
  code?: string;
  nextRetryInMs?: number;
}

export interface AutoSyncLike {
  start(): void;
  stop(): void;
  onStatus(listener: (status: AutoSyncStatus) => void): () => void;
}

/**
 * Dispara la sincronización sin que el usuario haga nada: al abrir, al volver la conexión, al volver a
 * primer plano, poco después de guardar y cada cierto tiempo. Si no hay conexión, reintenta con esperas
 * crecientes. En iOS no existe sincronización con la aplicación cerrada: todo esto ocurre con ella abierta.
 */
export class AutoSync implements AutoSyncLike {
  private current: AutoSyncStatus = { state: 'stopped', failures: 0 };
  private readonly listeners = new Set<(status: AutoSyncStatus) => void>();
  private started = false;
  private running = false;
  private rerun = false;
  private failures = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private nextTimer: ReturnType<typeof setTimeout> | undefined;
  private detachers: Array<() => void> = [];

  private readonly intervalMs: number;
  private readonly debounceMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly random: () => number;
  private readonly windowLike: EventTargetLike | null;
  private readonly documentLike: DocumentLike | null;

  constructor(
    private readonly engine: Pick<SyncEngine, 'syncOnce'>,
    private readonly source: ChangeSource,
    options: AutoSyncOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.debounceMs = options.debounceMs ?? 1_500;
    this.backoffBaseMs = options.backoffBaseMs ?? 5_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 300_000;
    this.random = options.random ?? Math.random;
    const g = globalThis as unknown as { addEventListener?: unknown; document?: DocumentLike };
    this.windowLike =
      options.windowLike !== undefined
        ? options.windowLike
        : typeof g.addEventListener === 'function'
          ? (globalThis as unknown as EventTargetLike)
          : null;
    this.documentLike = options.documentLike !== undefined ? options.documentLike : (g.document ?? null);
  }

  get status(): AutoSyncStatus {
    return this.current;
  }

  onStatus(listener: (status: AutoSyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.failures = 0;
    this.setStatus({ state: 'idle' });

    const onOnline = () => {
      this.failures = 0;
      void this.runSync();
    };
    const onVisibility = () => {
      if (this.documentLike?.visibilityState !== 'hidden') void this.runSync();
    };
    this.attach(this.windowLike, 'online', onOnline);
    this.attach(this.documentLike, 'visibilitychange', onVisibility);
    this.detachers.push(this.source.onChange(() => this.scheduleSave()));
    void this.runSync();
  }

  stop(): void {
    this.started = false;
    this.halt();
    this.setStatus({ state: 'stopped' });
  }

  /** Pide una sincronización ahora (por ejemplo, el botón "Sincronizar"). */
  syncNow(): Promise<void> {
    return this.runSync();
  }

  private attach(target: EventTargetLike | null, type: string, listener: () => void): void {
    if (!target) return;
    target.addEventListener(type, listener);
    this.detachers.push(() => target.removeEventListener(type, listener));
  }

  private halt(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    if (this.nextTimer !== undefined) clearTimeout(this.nextTimer);
    this.debounceTimer = undefined;
    this.nextTimer = undefined;
    for (const detach of this.detachers) detach();
    this.detachers = [];
  }

  private scheduleSave(): void {
    if (!this.started) return;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runSync();
    }, this.debounceMs);
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.nextTimer !== undefined) clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => {
      this.nextTimer = undefined;
      void this.runSync();
    }, delayMs);
  }

  private backoffMs(): number {
    const base = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.max(0, this.failures - 1));
    return Math.round(base * (1 + this.random() * 0.2));
  }

  private async runSync(): Promise<void> {
    if (!this.started) return;
    if (this.running) {
      this.rerun = true; // algo se guardó durante la sincronización: se vuelve a pasar al terminar
      return;
    }
    this.running = true;
    if (this.nextTimer !== undefined) {
      clearTimeout(this.nextTimer);
      this.nextTimer = undefined;
    }
    this.setStatus({ state: 'syncing' });
    try {
      let report: SyncReport;
      do {
        this.rerun = false;
        report = await this.engine.syncOnce();
        if (report.status === 'offline') {
          this.failures++;
          const delay = this.backoffMs();
          this.setStatus({ state: 'offline', nextRetryInMs: delay });
          this.schedule(delay);
          return;
        }
      } while (this.rerun && this.started);
      this.failures = 0;
      this.setStatus({ state: 'idle', lastReport: report });
      this.schedule(this.intervalMs);
    } catch (err) {
      if (err instanceof SessionError) {
        this.started = false;
        this.halt();
        this.setStatus({ state: 'session-lost', code: err.code, error: err.message });
        return;
      }
      this.failures++;
      const delay = this.backoffMs();
      this.setStatus({
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
        nextRetryInMs: delay,
      });
      this.schedule(delay);
    } finally {
      this.running = false;
    }
  }

  private setStatus(patch: Omit<AutoSyncStatus, 'failures'>): void {
    this.current = { ...patch, failures: this.failures, lastReport: patch.lastReport ?? this.current.lastReport };
    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch {
        // un oyente defectuoso no debe frenar la sincronización
      }
    }
  }
}
