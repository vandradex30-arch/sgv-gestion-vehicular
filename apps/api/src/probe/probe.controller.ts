import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { TenantDb } from '../database/tenant-db.service';
import { TenantTransactionInterceptor } from '../database/tenant-transaction.interceptor';

/** Endpoint de demostración del patrón RLS. Solo se registra con ALLOW_DEV_ACTOR=true. */
@Controller('probe')
@UseInterceptors(TenantTransactionInterceptor)
export class ProbeController {
  constructor(private readonly db: TenantDb) {}

  @Get()
  async list(): Promise<Array<{ id: string; note: string }>> {
    const result = await this.db.query<{ id: string; note: string }>(
      'SELECT id, note FROM public.rls_probe ORDER BY note',
    );
    return result.rows;
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: { note?: unknown }): Promise<{ id: string }> {
    if (typeof body?.note !== 'string' || body.note.length === 0 || body.note.length > 200) {
      throw new BadRequestException('note inválido');
    }
    const result = await this.db.query<{ id: string }>(
      'INSERT INTO public.rls_probe (organization_id, owner_id, note) VALUES (app.organization_id(), app.user_id(), $1) RETURNING id',
      [body.note],
    );
    return result.rows[0];
  }
}
