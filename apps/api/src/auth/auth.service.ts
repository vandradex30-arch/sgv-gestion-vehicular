import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { ENV, Env } from '../config/env';
import { PG_POOL } from '../database/tokens';
import { TenantDb } from '../database/tenant-db.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface LoginInput {
  email: string;
  password: string;
  deviceId: string;
  deviceLabel: string;
  platform: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface FoundUser {
  id: string;
  organization_id: string;
  password_hash: string;
  status: string;
  locked_until: Date | null;
}

interface FoundSession {
  id: string;
  organization_id: string;
  user_id: string;
  device_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  device_status: string;
  user_status: string;
}

const invalidCredentials = () =>
  new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' });
const invalidSession = () =>
  new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Sesión inválida' });

@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ENV) private readonly env: Env,
    private readonly db: TenantDb,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async login(input: LoginInput, ip: string | undefined): Promise<TokenPair> {
    const found = (
      await this.pool.query<FoundUser>('SELECT * FROM app.auth_find_user($1)', [input.email])
    ).rows[0];

    if (!found) {
      await this.passwords.verifyDummy(input.password);
      throw invalidCredentials();
    }
    if (found.locked_until && new Date(found.locked_until) > new Date()) {
      throw new HttpException(
        { code: 'ACCOUNT_LOCKED', message: 'Demasiados intentos fallidos. Inténtalo más tarde.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const passwordOk = await this.passwords.verify(found.password_hash, input.password);
    if (!passwordOk || found.status !== 'activo') {
      if (!passwordOk) {
        await this.pool.query('SELECT app.auth_register_failure($1, $2, $3)', [
          found.id,
          this.env.maxFailedAttempts,
          this.env.lockMinutes,
        ]);
      }
      await this.pool.query('SELECT app.log_event($1, $2, NULL, $3, $4, $5, $6::jsonb)', [
        found.organization_id,
        found.id,
        'LOGIN_FAILED',
        'user',
        found.id,
        JSON.stringify({ ip: ip ?? null, reason: passwordOk ? 'usuario_inactivo' : 'clave_incorrecta' }),
      ]);
      throw invalidCredentials();
    }

    await this.pool.query('SELECT app.auth_register_success($1)', [found.id]);

    const actor = { userId: found.id, organizationId: found.organization_id, deviceId: input.deviceId };
    return this.db.runInTransaction(actor, async () => {
      await this.db.query(
        `INSERT INTO public.devices (id, organization_id, user_id, label, platform)
         VALUES ($1, app.organization_id(), app.user_id(), $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [input.deviceId, input.deviceLabel, input.platform],
      );
      const device = (
        await this.db.query<{ user_id: string; status: string }>(
          'SELECT user_id, status FROM public.devices WHERE id = $1',
          [input.deviceId],
        )
      ).rows[0];
      if (!device || device.user_id !== found.id) {
        throw new ForbiddenException({ code: 'DEVICE_NOT_ALLOWED', message: 'Dispositivo no permitido' });
      }
      if (device.status !== 'activo') {
        throw new ForbiddenException({ code: 'DEVICE_REVOKED', message: 'Dispositivo revocado' });
      }
      await this.db.query('UPDATE public.devices SET last_seen_at = now(), label = $2 WHERE id = $1', [
        input.deviceId,
        input.deviceLabel,
      ]);

      const refresh = this.tokens.newRefresh();
      await this.insertSession(refresh.sessionId, input.deviceId, refresh.hash, null);
      await this.db.query('SELECT app.log_event(app.organization_id(), app.user_id(), app.device_id(), $1, $2, $3, $4::jsonb)', [
        'LOGIN',
        'session',
        refresh.sessionId,
        JSON.stringify({ ip: ip ?? null }),
      ]);
      return this.pair(found.id, found.organization_id, input.deviceId, refresh.sessionId, refresh.token);
    });
  }

  async refresh(token: unknown, ip: string | undefined): Promise<TokenPair> {
    const parts = this.tokens.parseRefresh(token);
    if (!parts) throw invalidSession();

    const session = (
      await this.pool.query<FoundSession>('SELECT * FROM app.auth_find_session($1)', [parts.sessionId])
    ).rows[0];
    if (!session || !this.tokens.matches(parts.secret, session.token_hash)) {
      throw invalidSession();
    }
    if (session.revoked_at) {
      await this.handleReuse(session, ip);
      throw invalidSession();
    }
    if (new Date(session.expires_at) <= new Date()) throw invalidSession();
    if (session.device_status !== 'activo') {
      throw new UnauthorizedException({ code: 'DEVICE_REVOKED', message: 'Dispositivo revocado' });
    }
    if (session.user_status !== 'activo') {
      throw new UnauthorizedException({ code: 'USER_DISABLED', message: 'Usuario desactivado' });
    }

    const actor = {
      userId: session.user_id,
      organizationId: session.organization_id,
      deviceId: session.device_id,
    };
    const result = await this.db.runInTransaction(actor, async () => {
      const revoked = await this.db.query(
        'UPDATE public.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id',
        [session.id],
      );
      if (revoked.rowCount === 0) return null; // otro refresh ganó la carrera: se trata como reutilización
      const next = this.tokens.newRefresh();
      await this.insertSession(next.sessionId, session.device_id, next.hash, session.id);
      await this.db.query('UPDATE public.devices SET last_seen_at = now() WHERE id = $1', [session.device_id]);
      return this.pair(session.user_id, session.organization_id, session.device_id, next.sessionId, next.token);
    });
    if (!result) {
      await this.handleReuse(session, ip);
      throw invalidSession();
    }
    return result;
  }

  async logout(token: unknown): Promise<void> {
    const parts = this.tokens.parseRefresh(token);
    if (!parts) return;
    const session = (
      await this.pool.query<FoundSession>('SELECT * FROM app.auth_find_session($1)', [parts.sessionId])
    ).rows[0];
    if (!session || session.revoked_at || !this.tokens.matches(parts.secret, session.token_hash)) return;
    const actor = {
      userId: session.user_id,
      organizationId: session.organization_id,
      deviceId: session.device_id,
    };
    await this.db.runInTransaction(actor, async () => {
      await this.db.query('UPDATE public.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [
        session.id,
      ]);
      await this.db.query(
        'SELECT app.log_event(app.organization_id(), app.user_id(), app.device_id(), $1, $2, $3, NULL)',
        ['LOGOUT', 'session', session.id],
      );
    });
  }

  private async handleReuse(session: FoundSession, ip: string | undefined): Promise<void> {
    await this.pool.query('SELECT app.auth_revoke_chain($1)', [session.id]);
    await this.pool.query('SELECT app.log_event($1, $2, $3, $4, $5, $6, $7::jsonb)', [
      session.organization_id,
      session.user_id,
      session.device_id,
      'REFRESH_REUSE',
      'session',
      session.id,
      JSON.stringify({ ip: ip ?? null }),
    ]);
  }

  private async insertSession(
    sessionId: string,
    deviceId: string,
    tokenHash: string,
    rotatedFrom: string | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO public.sessions
         (id, organization_id, user_id, device_id, token_hash, expires_at, rotated_from)
       VALUES ($1, app.organization_id(), app.user_id(), $2, $3,
               now() + make_interval(days => $4::int), $5)`,
      [sessionId, deviceId, tokenHash, this.env.refreshTtlDays, rotatedFrom],
    );
  }

  private pair(
    userId: string,
    organizationId: string,
    deviceId: string,
    sessionId: string,
    refreshToken: string,
  ): TokenPair {
    return {
      accessToken: this.tokens.signAccess({ userId, organizationId, deviceId, sessionId }),
      refreshToken,
      expiresIn: this.tokens.expiresIn,
    };
  }
}
