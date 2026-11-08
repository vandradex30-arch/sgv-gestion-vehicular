import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { TenantDb } from '../database/tenant-db.service';
import { Secured } from '../security/secured.decorator';

@Controller('audit')
export class AuditController {
  constructor(private readonly db: TenantDb) {}

  @Get()
  @Secured('audit', 'read')
  async list(@Query('limit') limitRaw?: string): Promise<unknown[]> {
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new BadRequestException('limit debe ser un entero entre 1 y 200');
    }
    const result = await this.db.query(
      `SELECT id, occurred_at AS "occurredAt", entity_type AS "entityType", entity_id AS "entityId",
              action, changed_fields AS "changedFields", user_id AS "userId", device_id AS "deviceId"
         FROM public.audit_log ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return result.rows;
  }
}
