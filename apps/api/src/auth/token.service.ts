import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ENV, Env } from '../config/env';
import { UUID_RE } from '../common/validation';

export interface RefreshTokenParts {
  sessionId: string;
  secret: string;
}

@Injectable()
export class TokenService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  signAccess(input: { userId: string; organizationId: string; deviceId: string; sessionId: string }): string {
    return jwt.sign({ org: input.organizationId, dev: input.deviceId, sid: input.sessionId }, this.env.jwtSecret, {
      algorithm: 'HS256',
      subject: input.userId,
      expiresIn: this.env.accessTtlSeconds,
    });
  }

  /** El refresh token es "<idSesión>.<secreto>". Solo se guarda el hash del secreto. */
  newRefresh(): { sessionId: string; token: string; hash: string } {
    const sessionId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    return { sessionId, token: `${sessionId}.${secret}`, hash: this.hashSecret(secret) };
  }

  parseRefresh(token: unknown): RefreshTokenParts | null {
    if (typeof token !== 'string' || token.length > 200) return null;
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const sessionId = token.slice(0, dot);
    const secret = token.slice(dot + 1);
    if (!UUID_RE.test(sessionId) || secret.length < 20) return null;
    return { sessionId: sessionId.toLowerCase(), secret };
  }

  hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  matches(secret: string, storedHash: string): boolean {
    const a = Buffer.from(this.hashSecret(secret), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  get expiresIn(): number {
    return this.env.accessTtlSeconds;
  }
}
