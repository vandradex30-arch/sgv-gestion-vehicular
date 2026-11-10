import type { AuthClient } from './auth-client';
import type { AutoSyncLike, AutoSyncStatus } from './autosync';
import type { SyncEngine } from './engine';
import { GraceExpiredError, NoRecoveryKeyError } from './errors';
import { createRecoveryBundle, RecoveryPayload } from './recovery';
import type { LocalStore } from './store';

export type SessionState =
  | { kind: 'logged-out' }
  | { kind: 'locked'; reason: 'manual' | 'inactivity' | 'pending-at-logout' | 'grace-expired'; pending: number }
  | { kind: 'active'; needsOnlineLogin: boolean }
  | { kind: 'quarantine'; reason: string; pending: number };

export interface SessionDeps {
  store: LocalStore;
  auth: Pick<AuthClient, 'login' | 'logout' | 'isLoggedIn'>;
  engine: Pick<SyncEngine, 'syncOnce'>;
  autoSync: AutoSyncLike;
  orgId: string;
  userId: string;
  deviceLabel?: string;
  platform?: string;
  /** Obtiene la llave pública de recuperación de la organización (se guarda en el dispositivo). */
  fetchRecoveryKey?: () => Promise<string | null>;
  /** Tiempo máximo sin verificar la sesión en línea. Por defecto 7 días. */
  graceMs?: number;
  /** Bloqueo automático por inactividad. Sin valor, no se bloquea solo. */
  inactivityMs?: number;
  now?: () => number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
}

/** Códigos de sesión caída que significan "este equipo ya no es de confianza": se pasa a cuarentena. */
const QUARANTINE_CODES = ['DEVICE_REVOKED', 'USER_DISABLED'];

/**
 * Coordina el ciclo de vida de la sesión en un dispositivo. Regla central: cerrar sesión o perder el
 * acceso nunca borra registros que el servidor aún no confirmó. En su lugar se bloquea el equipo, o se
 * entra en cuarentena con un paquete de recuperación que un administrador puede revisar.
 */
export class SessionManager {
  private current: SessionState = { kind: 'logged-out' };
  private readonly listeners = new Set<(state: SessionState) => void>();
  private inactivityTimer: unknown;
  private readonly now: () => number;
  private readonly graceMs: number;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.graceMs = deps.graceMs ?? 7 * 24 * 60 * 60 * 1000;
    deps.autoSync.onStatus((status) => void this.onSyncStatus(status));
  }

  get state(): SessionState {
    return this.current;
  }

  onState(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Desbloquea con el PIN. Si pasó demasiado tiempo sin conexión, exige reconectar (sin tocar los datos). */
  async unlock(pin: string): Promise<void> {
    const { store } = this.deps;
    const last = await store.getMeta<number>('lastOnlineVerifiedAt');
    if (last !== undefined && this.now() - last > this.graceMs) {
      this.set({ kind: 'locked', reason: 'grace-expired', pending: await store.pendingCount() });
      throw new GraceExpiredError();
    }
    await store.unlock(pin);
    this.touch();
    const needsOnlineLogin = !this.deps.auth.isLoggedIn;
    this.set({ kind: 'active', needsOnlineLogin });
    if (!needsOnlineLogin) this.deps.autoSync.start();
  }

  /** Inicio de sesión en línea: renueva la confianza del dispositivo y obtiene la llave de recuperación. */
  async loginOnline(email: string, password: string): Promise<void> {
    const { store, auth } = this.deps;
    await auth.login({
      email,
      password,
      deviceId: store.deviceId,
      deviceLabel: this.deps.deviceLabel ?? 'Dispositivo',
      platform: this.deps.platform ?? 'web',
    });
    await store.resetUnlockAttempts();
    await store.setMeta('lastOnlineVerifiedAt', this.now());
    if (this.deps.fetchRecoveryKey) {
      try {
        const key = await this.deps.fetchRecoveryKey();
        if (key) await store.setMeta('recoveryPublicKey', key);
      } catch {
        // sin la llave no se puede exportar un paquete, pero iniciar sesión sigue siendo válido
      }
    }
    if (store.isUnlocked) {
      this.set({ kind: 'active', needsOnlineLogin: false });
      this.deps.autoSync.start();
    }
  }

  lock(reason: 'manual' | 'inactivity' = 'manual'): void {
    this.clearInactivity();
    this.deps.autoSync.stop();
    this.deps.store.lock();
    void this.deps.store.pendingCount().then((pending) => this.set({ kind: 'locked', reason, pending }));
  }

  /** Cada interacción del usuario reinicia el reloj de inactividad. */
  touch(): void {
    const { inactivityMs, timers } = this.deps;
    if (!inactivityMs) return;
    this.clearInactivity();
    const set = timers?.set ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.inactivityTimer = set(() => this.lock('inactivity'), inactivityMs);
  }

  private clearInactivity(): void {
    if (this.inactivityTimer === undefined) return;
    const clear = this.deps.timers?.clear ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    clear(this.inactivityTimer);
    this.inactivityTimer = undefined;
  }

  /**
   * Cerrar sesión. Primero intenta sincronizar; si todo quedó confirmado, borra los datos locales.
   * Si queda algo pendiente (o no hay conexión), NO borra nada: bloquea el equipo y lo informa.
   */
  async requestLogout(): Promise<{ outcome: 'done' } | { outcome: 'locked'; pending: number }> {
    const { store, auth, engine, autoSync } = this.deps;
    this.clearInactivity();
    if (store.isUnlocked) {
      try {
        await engine.syncOnce();
      } catch {
        // sin conexión o sesión caída: se evalúa más abajo con lo que quedó pendiente
      }
    }
    autoSync.stop();
    const pending = await store.pendingCount();
    if (pending === 0) {
      await auth.logout();
      await store.safeWipe();
      this.set({ kind: 'logged-out' });
      return { outcome: 'done' };
    }
    store.lock();
    this.set({ kind: 'locked', reason: 'pending-at-logout', pending });
    return { outcome: 'locked', pending };
  }

  /** El equipo dejó de ser de confianza (revocado, usuario desactivado): se conserva todo, bloqueado. */
  async enterQuarantine(reason: string): Promise<void> {
    this.clearInactivity();
    this.deps.autoSync.stop();
    this.deps.store.lock();
    this.set({ kind: 'quarantine', reason, pending: await this.deps.store.pendingCount() });
  }

  /**
   * Genera el paquete de recuperación: las operaciones pendientes cifradas con la llave de la organización.
   * Se entrega como texto para guardarlo en un archivo y llevárselo a un administrador.
   */
  async exportRecovery(pin: string): Promise<string> {
    const { store } = this.deps;
    const publicKey = await store.getMeta<string>('recoveryPublicKey');
    if (!publicKey) throw new NoRecoveryKeyError();
    await store.unlock(pin);
    try {
      const ops = await store.collectRecoveryOps();
      const payload: RecoveryPayload = {
        v: 1,
        orgId: this.deps.orgId,
        userId: this.deps.userId,
        deviceId: store.deviceId,
        createdAt: new Date(this.now()).toISOString(),
        ops,
      };
      const bundle = await createRecoveryBundle(payload, publicKey);
      await store.markRecoveryExported(ops.map((o) => o.operationId));
      return JSON.stringify(bundle);
    } finally {
      store.lock();
    }
  }

  /** Termina la cuarentena y borra los datos locales, solo si todo lo pendiente ya fue exportado. */
  async finishQuarantine(): Promise<void> {
    await this.deps.store.wipeAfterRecovery();
    this.set({ kind: 'logged-out' });
  }

  private async onSyncStatus(status: AutoSyncStatus): Promise<void> {
    const { store } = this.deps;
    if (status.state === 'idle' && status.lastReport) {
      await store.setMeta('lastOnlineVerifiedAt', this.now());
    } else if (status.state === 'session-lost') {
      if (status.code && QUARANTINE_CODES.includes(status.code)) {
        await this.enterQuarantine(status.code);
      } else {
        this.set({ kind: 'active', needsOnlineLogin: true });
      }
    }
  }

  private set(state: SessionState): void {
    this.current = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // un oyente defectuoso no debe afectar la sesión
      }
    }
  }
}
