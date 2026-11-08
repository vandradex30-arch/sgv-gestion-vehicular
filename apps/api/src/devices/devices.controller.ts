import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { assertUuid } from '../common/validation';
import { TenantDb } from '../database/tenant-db.service';
import { Secured } from '../security/secured.decorator';

@Controller('devices')
export class DevicesController {
  constructor(private readonly db: TenantDb) {}

  @Get()
  @Secured('device', 'manage')
  async list(): Promise<unknown[]> {
    const result = await this.db.query(
      `SELECT d.id, d.user_id AS "userId", u.email, d.label, d.platform, d.status,
              d.last_seen_at AS "lastSeenAt", d.pending_ops_count AS "pendingOpsCount"
         FROM public.devices d JOIN public.users u ON u.id = d.user_id
        ORDER BY d.registered_at DESC`,
    );
    return result.rows;
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @Secured('device', 'manage')
  async revoke(@Param('id') id: string, @Body() body: { status?: unknown }): Promise<{ id: string; status: string }> {
    const deviceId = assertUuid(id, 'id');
    const status = body?.status ?? 'revocado';
    if (status !== 'revocado' && status !== 'perdido') {
      throw new BadRequestException('status inválido');
    }
    const result = await this.db.query<{ ok: boolean }>('SELECT app.revoke_device($1, $2) AS ok', [deviceId, status]);
    if (!result.rows[0]?.ok) throw new NotFoundException();
    return { id: deviceId, status };
  }
}
