import { NetworkError, ProtocolError, SessionError } from './errors';
import type {
  ConflictResolution,
  PullRequest,
  PullResponse,
  PushOperation,
  PushResponse,
  ResolveResponse,
  ServerConflict,
} from './protocol';

export interface SyncTransport {
  push(operations: PushOperation[]): Promise<PushResponse>;
  pull(request: PullRequest): Promise<PullResponse>;
  listConflicts(): Promise<ServerConflict[]>;
  resolveConflict(
    id: string,
    resolution: ConflictResolution,
    patch?: Record<string, unknown>,
  ): Promise<ResolveResponse>;
}

export interface HttpTransportOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
}

/**
 * Transporte HTTP. Traduce los fallos en tres familias:
 * NetworkError (sin conexión o servidor caído: se reintenta), SessionError (401: la sesión ya no vale)
 * y ProtocolError (el servidor rechazó la petición: es un error de programación o de datos).
 */
export class HttpTransport implements SyncTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  push(operations: PushOperation[]): Promise<PushResponse> {
    return this.request<PushResponse>('POST', '/sync/push', { operations });
  }

  pull(request: PullRequest): Promise<PullResponse> {
    return this.request<PullResponse>('POST', '/sync/pull', request);
  }

  listConflicts(): Promise<ServerConflict[]> {
    return this.request<ServerConflict[]>('GET', '/sync/conflicts?status=abierto');
  }

  resolveConflict(
    id: string,
    resolution: ConflictResolution,
    patch?: Record<string, unknown>,
  ): Promise<ResolveResponse> {
    return this.request<ResolveResponse>('POST', `/sync/conflicts/${encodeURIComponent(id)}/resolve`, {
      resolution,
      patch,
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.options.getAccessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new NetworkError();
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok) return payload as T;

    const code = (payload as { code?: string } | null)?.code;
    if (response.status === 401) throw new SessionError(code ?? 'UNAUTHORIZED');
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      throw new NetworkError(`Servidor no disponible (${response.status})`);
    }
    throw new ProtocolError(
      (payload as { message?: string } | null)?.message ?? `Error ${response.status}`,
      response.status,
    );
  }
}
