import * as jwt from 'jsonwebtoken';
import { Actor, ActorResolver, RequestLike } from './actor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identidad desde el token de acceso (HS256). Un token inválido o vencido equivale a no estar autenticado. */
export class JwtActorResolver extends ActorResolver {
  constructor(private readonly secret: string) {
    super();
  }

  resolve(req: RequestLike): Actor | null {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return null;
    }
    try {
      const payload = jwt.verify(header.slice(7), this.secret, { algorithms: ['HS256'] });
      if (typeof payload === 'string') return null;
      const { sub, org, dev, sid } = payload as jwt.JwtPayload & {
        org?: string;
        dev?: string;
        sid?: string;
      };
      if (!sub || !org || !UUID.test(sub) || !UUID.test(org)) return null;
      return {
        userId: sub,
        organizationId: org,
        deviceId: dev && UUID.test(dev) ? dev : null,
        sessionId: sid && UUID.test(sid) ? sid : null,
      };
    } catch {
      return null;
    }
  }
}

/** SOLO desarrollo y pruebas (ALLOW_DEV_ACTOR=true, prohibido en producción por loadEnv). */
export class DevActorResolver extends ActorResolver {
  resolve(req: RequestLike): Actor | null {
    const header = (name: string): string | undefined => {
      const value = req.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const userId = header('x-dev-user-id');
    const organizationId = header('x-dev-org-id');
    const deviceId = header('x-dev-device-id');
    if (!userId || !organizationId || !UUID.test(userId) || !UUID.test(organizationId)) {
      return null;
    }
    if (deviceId && !UUID.test(deviceId)) {
      return null;
    }
    return { userId, organizationId, deviceId: deviceId ?? null, sessionId: null };
  }
}

export class ChainedActorResolver extends ActorResolver {
  constructor(private readonly resolvers: ActorResolver[]) {
    super();
  }

  resolve(req: RequestLike): Actor | null {
    for (const resolver of this.resolvers) {
      const actor = resolver.resolve(req);
      if (actor) return actor;
    }
    return null;
  }
}
