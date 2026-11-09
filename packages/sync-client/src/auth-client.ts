import { NetworkError, ProtocolError, SessionError } from './errors';

export interface LoginInput {
  email: string;
  password: string;
  deviceId: string;
  deviceLabel: string;
  platform: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Sesión con el servidor. Renueva el token de acceso poco antes de que venza y comparte una sola
 * renovación entre llamadas simultáneas (renovar dos veces el mismo token se interpreta como robo).
 */
export class AuthClient {
  private tokens: TokenPair | null = null;
  private expiresAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get isLoggedIn(): boolean {
    return this.tokens !== null;
  }

  get refreshToken(): string | null {
    return this.tokens?.refreshToken ?? null;
  }

  async login(input: LoginInput): Promise<void> {
    this.setTokens(await this.post<TokenPair>('/auth/login', input));
  }

  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new SessionError('NOT_LOGGED_IN');
    if (this.now() >= this.expiresAt - 30_000) {
      if (!this.refreshing) {
        this.refreshing = this.doRefresh().finally(() => {
          this.refreshing = null;
        });
      }
      await this.refreshing;
    }
    return (this.tokens as TokenPair).accessToken;
  }

  async logout(): Promise<void> {
    const token = this.tokens?.refreshToken;
    this.tokens = null;
    if (token) {
      try {
        await this.post('/auth/logout', { refreshToken: token });
      } catch {
        // Sin conexión: la sesión del servidor vencerá sola; localmente ya quedó cerrada.
      }
    }
  }

  private async doRefresh(): Promise<void> {
    const token = this.tokens?.refreshToken;
    if (!token) throw new SessionError('NOT_LOGGED_IN');
    this.setTokens(await this.post<TokenPair>('/auth/refresh', { refreshToken: token }));
  }

  private setTokens(tokens: TokenPair): void {
    this.tokens = tokens;
    this.expiresAt = this.now() + tokens.expiresIn * 1000;
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new SessionError(code ?? `HTTP_${response.status}`);
    }
    if (response.status >= 500) throw new NetworkError(`Servidor no disponible (${response.status})`);
    throw new ProtocolError((payload as { message?: string } | null)?.message ?? `Error ${response.status}`, response.status);
  }
}
