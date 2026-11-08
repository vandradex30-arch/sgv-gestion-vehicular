import { Injectable } from '@nestjs/common';
import { Actor, ActorResolver, RequestLike } from './actor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Seguro por defecto: sin autenticación real (Etapa 1) nadie entra. */
@Injectable()
export class DenyAllActorResolver extends ActorResolver {
  resolve(): Actor | null {
    return null;
  }
}

/** SOLO desarrollo y pruebas (ALLOW_DEV_ACTOR=true, prohibido en producción por loadEnv). */
@Injectable()
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
    return { userId, organizationId, deviceId: deviceId ?? null };
  }
}
