import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Actor } from '../database/actor';
import { assertUuid } from '../common/validation';
import { Secured } from '../security/secured.decorator';
import { QuarantineService } from './quarantine.service';

@Controller('sync')
export class QuarantineController {
  constructor(private readonly quarantine: QuarantineService) {}

  /** Los dispositivos la guardan al iniciar sesión para poder exportar un paquete incluso sin conexión. */
  @Get('recovery-key')
  @Secured()
  recoveryKey(): { publicKey: string | null } {
    return { publicKey: this.quarantine.publicKey() };
  }

  @Post('quarantine/import')
  @HttpCode(201)
  @Secured('device', 'manage')
  import(@Body() body: { bundle?: unknown }, @Req() req: { actor: Actor }): Promise<{ id: string; opCount: number }> {
    return this.quarantine.import(req.actor, body?.bundle);
  }

  @Get('quarantine')
  @Secured('device', 'manage')
  list(@Query('status') status?: string): Promise<unknown[]> {
    const wanted = status ?? 'pendiente';
    if (!['pendiente', 'aceptada', 'descartada'].includes(wanted)) throw new BadRequestException('status inválido');
    return this.quarantine.list(wanted);
  }

  @Post('quarantine/:id/review')
  @HttpCode(200)
  @Secured('device', 'manage')
  review(
    @Param('id') id: string,
    @Body() body: { status?: unknown; note?: unknown },
  ): Promise<{ id: string; status: string }> {
    const quarantineId = assertUuid(id, 'id');
    if (body?.status !== 'aceptada' && body?.status !== 'descartada') {
      throw new BadRequestException('status debe ser aceptada o descartada');
    }
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) {
      throw new BadRequestException('note inválida');
    }
    return this.quarantine.review(quarantineId, body.status, (body.note as string | undefined) ?? null);
  }
}
