import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, Observable } from 'rxjs';
import type { Actor } from '../database/actor';
import { TenantDb } from '../database/tenant-db.service';

export const PERMISSION_KEY = 'sgv.permission';

export interface PermissionRequirement {
  resource: string;
  action: string;
}

/**
 * Corre DENTRO de la transacción del usuario (después de TenantTransactionInterceptor):
 * 1) con sesión real, comprueba que sesión, dispositivo y usuario sigan vigentes;
 * 2) si el endpoint exige un permiso, lo verifica en la base de datos (nunca en el cliente).
 */
@Injectable()
export class SessionPermissionInterceptor implements NestInterceptor {
  constructor(
    private readonly db: TenantDb,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    return from(
      this.authorize(req, requirement).then(() =>
        lastValueFrom(next.handle(), { defaultValue: undefined }),
      ),
    );
  }

  private async authorize(
    req: { actor?: Actor; permissionScope?: string },
    requirement: PermissionRequirement | undefined,
  ): Promise<void> {
    const actor = req.actor;
    if (!actor) {
      throw new UnauthorizedException();
    }

    if (actor.sessionId) {
      const result = await this.db.query<{
        device_status: string;
        revoked_at: Date | null;
        user_status: string;
      }>(
        `SELECT d.status AS device_status, s.revoked_at, u.status AS user_status
           FROM public.sessions s
           JOIN public.devices d ON d.id = s.device_id
           JOIN public.users u ON u.id = s.user_id
          WHERE s.id = $1`,
        [actor.sessionId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Sesión inválida' });
      }
      if (row.device_status !== 'activo') {
        throw new UnauthorizedException({ code: 'DEVICE_REVOKED', message: 'Dispositivo revocado' });
      }
      if (row.revoked_at) {
        throw new UnauthorizedException({ code: 'SESSION_REVOKED', message: 'Sesión cerrada' });
      }
      if (row.user_status !== 'activo') {
        throw new UnauthorizedException({ code: 'USER_DISABLED', message: 'Usuario desactivado' });
      }
    }

    if (requirement) {
      const result = await this.db.query<{ scope: string | null }>(
        'SELECT app.permission_scope($1, $2) AS scope',
        [requirement.resource, requirement.action],
      );
      const scope = result.rows[0]?.scope ?? null;
      if (!scope) {
        throw new ForbiddenException('No tienes permiso para esta acción');
      }
      req.permissionScope = scope;
    }
  }
}
