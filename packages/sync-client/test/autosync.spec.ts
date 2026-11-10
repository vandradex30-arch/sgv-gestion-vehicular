import { AutoSync, AutoSyncStatus } from '../src/autosync';
import { SessionError } from '../src/errors';
import type { SyncReport } from '../src/types';

const ok: SyncReport = { status: 'ok', applied: 0, duplicates: 0, conflicts: 0, rejected: 0, pulled: 0 };
const offline: SyncReport = { ...ok, status: 'offline' };

class FakeTarget {
  private handlers = new Map<string, Set<() => void>>();
  visibilityState = 'visible';
  addEventListener(type: string, listener: () => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.handlers.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const l of [...(this.handlers.get(type) ?? [])]) l();
  }
  count(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

class FakeStore {
  private listeners = new Set<() => void>();
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(): void {
    for (const l of [...this.listeners]) l();
  }
  get count(): number {
    return this.listeners.size;
  }
}

function setup(options: Record<string, unknown> = {}) {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const store = new FakeStore();
  const engine = { syncOnce: jest.fn<Promise<SyncReport>, []>().mockResolvedValue(ok) };
  const auto = new AutoSync(engine, store, { random: () => 0, windowLike: win, documentLike: doc, ...options });
  return { win, doc, store, engine, auto };
}

const tick = (ms = 0) => jest.advanceTimersByTimeAsync(ms);

describe('sincronización automática', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sincroniza al arrancar y luego cada cierto tiempo', async () => {
    const { engine, auto } = setup();
    auto.start();
    await tick();
    expect(engine.syncOnce).toHaveBeenCalledTimes(1);
    await tick(59_999);
    expect(engine.syncOnce).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(engine.syncOnce).toHaveBeenCalledTimes(2);
    auto.stop();
  });

  it('tras guardar espera un momento y agrupa varios guardados en una sola sincronización', async () => {
    const { engine, store, auto } = setup();
    auto.start();
    await tick();
    expect(engine.syncOnce).toHaveBeenCalledTimes(1);

    store.emit();
    await tick(500);
    store.emit();
    await tick(500);
    store.emit();
    await tick(1_499);
    expect(engine.syncOnce).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(engine.syncOnce).toHaveBeenCalledTimes(2);
    auto.stop();
  });

  it('sin conexión reintenta con esperas crecientes y se recupera al volver la red', async () => {
    const { engine, auto } = setup();
    engine.syncOnce.mockResolvedValueOnce(offline).mockResolvedValueOnce(offline).mockResolvedValueOnce(offline);
    const seen: AutoSyncStatus[] = [];
    auto.onStatus((s) => seen.push(s));
    auto.start();
    await tick();
    expect(engine.syncOnce).toHaveBeenCalledTimes(1);
    expect(auto.status).toMatchObject({ state: 'offline', failures: 1, nextRetryInMs: 5_000 });

    await tick(4_999);
    expect(engine.syncOnce).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(engine.syncOnce).toHaveBeenCalledTimes(2);
    expect(auto.status).toMatchObject({ state: 'offline', failures: 2, nextRetryInMs: 10_000 });

    await tick(10_000);
    expect(engine.syncOnce).toHaveBeenCalledTimes(3);
    expect(auto.status).toMatchObject({ state: 'offline', failures: 3, nextRetryInMs: 20_000 });

    await tick(20_000);
    expect(engine.syncOnce).toHaveBeenCalledTimes(4);
    expect(auto.status).toMatchObject({ state: 'idle', failures: 0 });
    expect(seen.some((s) => s.state === 'syncing')).toBe(true);
    auto.stop();
  });

  it('al volver la conexión sincroniza de inmediato sin esperar el reintento', async () => {
    const { engine, win, auto } = setup();
    engine.syncOnce.mockResolvedValueOnce(offline);
    auto.start();
    await tick();
    expect(auto.status.state).toBe('offline');

    win.emit('online');
    await tick();
    expect(engine.syncOnce).toHaveBeenCalledTimes(2);
    expect(auto.status).toMatchObject({ state: 'idle', failures: 0 });
    auto.stop();
  });

  it('sincroniza al volver a primer plano, pero no cuando la pantalla se oculta', async () => {
    const { engine, doc, auto } = setup();
    auto.start();
    await tick();
    expect(engine.syncOnce).toHaveBeenCalledTimes(1);

    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    await tick();
    expect(engine.syncOnce).toHaveBeenCalledTimes(1);

    doc.visibilityState = 'visible';
    doc.emit('visibilitychange');
    await tick();
    expect(engine.syncOnce).toHaveBeenCalledTimes(2);
    auto.stop();
  });

  it('lo guardado durante una sincronización se envía al terminar, sin esperar al siguiente turno', async () => {
    const { engine, store, auto } = setup();
    let release!: (r: SyncReport) => void;
    engine.syncOnce.mockImplementationOnce(() => new Promise<SyncReport>((resolve) => (release = resolve)));
    auto.start();
    await tick();
    expect(auto.status.state).toBe('syncing');

    store.emit();
    await tick(1_500); // el guardado dispara una petición mientras todavía se sincroniza
    expect(engine.syncOnce).toHaveBeenCalledTimes(1);

    release(ok);
    await tick();
    expect(engine.syncOnce).toHaveBeenCalledTimes(2);
    auto.stop();
  });

  it('si la sesión se cae se detiene del todo e informa el motivo', async () => {
    const { engine, win, store, auto } = setup();
    engine.syncOnce.mockRejectedValueOnce(new SessionError('DEVICE_REVOKED'));
    auto.start();
    await tick();
    expect(auto.status).toMatchObject({ state: 'session-lost', code: 'DEVICE_REVOKED' });

    store.emit();
    win.emit('online');
    await tick(10 * 60_000);
    expect(engine.syncOnce).toHaveBeenCalledTimes(1);
    expect(win.count('online')).toBe(0);
    expect(store.count).toBe(0);
  });

  it('un error inesperado reintenta con espera, y detener la sincronización cancela todo', async () => {
    const { engine, win, auto } = setup();
    engine.syncOnce.mockRejectedValueOnce(new Error('falla rara'));
    auto.start();
    await tick();
    expect(auto.status).toMatchObject({ state: 'error', error: 'falla rara' });
    await tick(5_000);
    expect(engine.syncOnce).toHaveBeenCalledTimes(2);

    auto.stop();
    expect(auto.status.state).toBe('stopped');
    expect(win.count('online')).toBe(0);
    await tick(10 * 60_000);
    expect(engine.syncOnce).toHaveBeenCalledTimes(2);
  });
});
