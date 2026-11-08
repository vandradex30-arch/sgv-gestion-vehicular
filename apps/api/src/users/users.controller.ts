import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { PasswordService } from '../auth/password.service';
import { assertUuid, requireEmail, requireString } from '../common/validation';
import type { Actor } from '../database/actor';
import { TenantDb } from '../database/tenant-db.service';
import { Secured } from '../security/secured.decorator';

@Controller('users')
export class UsersController {
  constructor(
    private readonly db: TenantDb,
    private readonly passwords: PasswordService,
  ) {}

  @Post()
  @HttpCode(201)
  @Secured('user', 'manage')
  async create(@Body() body: unknown, @Req() req: { actor: Actor }): Promise<{ id: string; email: string }> {
    const email = requireEmail(body, 'email');
    const fullName = requireString(body, 'fullName', 1, 120);
    const password = requireString(body, 'password', 12, 200);
    const roleCode = requireString(body, 'roleCode', 1, 60);

    const role = (await this.db.query<{ id: string }>('SELECT id FROM public.roles WHERE code = $1', [roleCode]))
      .rows[0];
    if (!role) throw new BadRequestException('roleCode inválido');

    const hash = await this.passwords.hash(password);
    let userId: string;
    try {
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO public.users (organization_id, email, full_name, password_hash)
         VALUES (app.organization_id(), $1, $2, $3) RETURNING id`,
        [email, fullName, hash],
      );
      userId = inserted.rows[0].id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('Ya existe un usuario con ese correo');
      }
      throw err;
    }
    await this.db.query(
      `INSERT INTO public.user_roles (organization_id, user_id, role_id, assigned_by)
       VALUES (app.organization_id(), $1, $2, $3)`,
      [userId, role.id, req.actor.userId],
    );
    return { id: userId, email };
  }

  @Get()
  @Secured('user', 'manage')
  async list(): Promise<Array<{ id: string; email: string; fullName: string; status: string; lastLoginAt: Date | null }>> {
    const result = await this.db.query<{
      id: string;
      email: string;
      full_name: string;
      status: string;
      last_login_at: Date | null;
    }>('SELECT id, email, full_name, status, last_login_at FROM public.users WHERE deleted_at IS NULL ORDER BY email');
    return result.rows.map((r) => ({
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      status: r.status,
      lastLoginAt: r.last_login_at,
    }));
  }

  @Patch(':id/status')
  @Secured('user', 'manage')
  async setStatus(
    @Param('id') id: string,
    @Body() body: { status?: unknown },
    @Req() req: { actor: Actor },
  ): Promise<{ id: string; status: string }> {
    const userId = assertUuid(id, 'id');
    if (body?.status !== 'activo' && body?.status !== 'inactivo') {
      throw new BadRequestException('status inválido');
    }
    if (userId === req.actor.userId) {
      throw new BadRequestException('No puedes cambiar tu propio estado');
    }
    const result = await this.db.query<{ id: string }>(
      'UPDATE public.users SET status = $2 WHERE id = $1 RETURNING id',
      [userId, body.status],
    );
    if (result.rowCount === 0) throw new NotFoundException();
    return { id: userId, status: body.status };
  }
}
