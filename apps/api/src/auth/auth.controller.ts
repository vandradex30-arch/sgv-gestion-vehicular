import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { requireEmail, requireString, requireUuid } from '../common/validation';
import { TenantDb } from '../database/tenant-db.service';
import { Secured } from '../security/secured.decorator';
import { AuthService, TokenPair } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: { ip?: string }): Promise<TokenPair> {
    return this.auth.login(
      {
        email: requireEmail(body, 'email'),
        password: requireString(body, 'password', 1, 200),
        deviceId: requireUuid(body, 'deviceId'),
        deviceLabel: requireString(body, 'deviceLabel', 1, 80),
        platform: requireString(body, 'platform', 1, 40),
      },
      req.ip,
    );
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: { refreshToken?: unknown }, @Req() req: { ip?: string }): Promise<TokenPair> {
    return this.auth.refresh(body?.refreshToken, req.ip);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: { refreshToken?: unknown }): Promise<void> {
    await this.auth.logout(body?.refreshToken);
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly db: TenantDb) {}

  @Get()
  @Secured()
  async me(): Promise<{
    id: string;
    email: string;
    fullName: string;
    roles: Array<{ code: string; name: string }>;
    permissions: Array<{ resource: string; action: string; scope: string }>;
  }> {
    const user = (
      await this.db.query<{ id: string; email: string; full_name: string }>(
        'SELECT id, email, full_name FROM public.users WHERE id = app.user_id()',
      )
    ).rows[0];
    const roles = await this.db.query<{ code: string; name: string }>(
      `SELECT r.code, r.name
         FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
        WHERE ur.user_id = app.user_id() AND ur.revoked_at IS NULL
        ORDER BY r.code`,
    );
    const permissions = await this.db.query<{ resource: string; action: string; scope: string }>(
      `SELECT p.resource, p.action,
              CASE WHEN bool_or(rp.scope = 'all') THEN 'all'
                   WHEN bool_or(rp.scope = 'assigned') THEN 'assigned'
                   ELSE 'own' END AS scope
         FROM public.user_roles ur
         JOIN public.role_permissions rp ON rp.role_id = ur.role_id
         JOIN public.permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = app.user_id() AND ur.revoked_at IS NULL
        GROUP BY p.resource, p.action
        ORDER BY p.resource, p.action`,
    );
    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      roles: roles.rows,
      permissions: permissions.rows,
    };
  }
}
