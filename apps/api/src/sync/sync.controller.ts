import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { assertUuid, UUID_RE } from '../common/validation';
import type { Actor } from '../database/actor';
import { Secured } from '../security/secured.decorator';
import { SyncService } from './sync.service';
import type { OperationKind, PushOperation } from './sync.types';

const MAX_OPERATIONS = 50;
const MAX_PULL_LIMIT = 500;
const KINDS: OperationKind[] = ['create', 'update', 'delete'];

function parseOperation(raw: unknown, index: number): PushOperation {
  const fail = (what: string): never => {
    throw new BadRequestException(`operations[${index}].${what} inválido`);
  };
  if (raw === null || typeof raw !== 'object') return fail('formato');
  const o = raw as Record<string, unknown>;
  if (typeof o.operationId !== 'string' || !UUID_RE.test(o.operationId)) fail('operationId');
  if (typeof o.entityId !== 'string' || !UUID_RE.test(o.entityId)) fail('entityId');
  if (typeof o.entityType !== 'string' || o.entityType.length < 1 || o.entityType.length > 60) fail('entityType');
  if (typeof o.kind !== 'string' || !KINDS.includes(o.kind as OperationKind)) fail('kind');
  if (o.baseVersion !== null && o.baseVersion !== undefined) {
    if (typeof o.baseVersion !== 'number' || !Number.isInteger(o.baseVersion) || o.baseVersion < 1) fail('baseVersion');
  }
  if (o.patch !== undefined && (o.patch === null || typeof o.patch !== 'object' || Array.isArray(o.patch))) fail('patch');
  const clientAt = typeof o.clientUpdatedAt === 'string' ? Date.parse(o.clientUpdatedAt) : NaN;
  if (Number.isNaN(clientAt)) fail('clientUpdatedAt');
  if (typeof o.deviceSeq !== 'number' || !Number.isInteger(o.deviceSeq) || o.deviceSeq < 0) fail('deviceSeq');
  return {
    operationId: (o.operationId as string).toLowerCase(),
    entityType: o.entityType as string,
    entityId: (o.entityId as string).toLowerCase(),
    kind: o.kind as OperationKind,
    baseVersion: (o.baseVersion as number | null | undefined) ?? null,
    patch: (o.patch as Record<string, unknown> | undefined) ?? {},
    clientUpdatedAt: new Date(clientAt).toISOString(),
    deviceSeq: o.deviceSeq as number,
  };
}

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('push')
  @HttpCode(200)
  @Secured()
  async push(@Body() body: unknown, @Req() req: { actor: Actor }): Promise<{ results: unknown[] }> {
    const ops = (body as { operations?: unknown })?.operations;
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_OPERATIONS) {
      throw new BadRequestException(`operations debe tener entre 1 y ${MAX_OPERATIONS} elementos`);
    }
    const parsed = ops.map((op, i) => parseOperation(op, i));
    // Las operaciones se procesan en el orden del dispositivo: el padre llega antes que el hijo.
    parsed.sort((a, b) => a.deviceSeq - b.deviceSeq);
    return { results: await this.sync.push(req.actor, parsed) };
  }

  @Post('pull')
  @HttpCode(200)
  @Secured()
  async pull(@Body() body: unknown, @Req() req: { actor: Actor }): Promise<unknown> {
    const b = (body ?? {}) as { sinceSeq?: unknown; limit?: unknown; pendingOpsCount?: unknown };
    const sinceSeq = b.sinceSeq ?? 0;
    if (typeof sinceSeq !== 'number' || !Number.isInteger(sinceSeq) || sinceSeq < 0) {
      throw new BadRequestException('sinceSeq inválido');
    }
    const limit = b.limit ?? 200;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_PULL_LIMIT) {
      throw new BadRequestException(`limit debe estar entre 1 y ${MAX_PULL_LIMIT}`);
    }
    let pending: number | undefined;
    if (b.pendingOpsCount !== undefined) {
      if (typeof b.pendingOpsCount !== 'number' || !Number.isInteger(b.pendingOpsCount) || b.pendingOpsCount < 0) {
        throw new BadRequestException('pendingOpsCount inválido');
      }
      pending = b.pendingOpsCount;
    }
    return this.sync.pull(req.actor, sinceSeq, limit, pending);
  }

  @Get('conflicts')
  @Secured()
  async conflicts(@Query('status') status?: string): Promise<unknown[]> {
    const wanted = status ?? 'abierto';
    if (!['abierto', 'resuelto', 'descartado'].includes(wanted)) {
      throw new BadRequestException('status inválido');
    }
    return this.sync.listConflicts(wanted);
  }

  @Post('conflicts/:id/resolve')
  @HttpCode(200)
  @Secured()
  async resolve(
    @Param('id') id: string,
    @Body() body: { resolution?: unknown; patch?: unknown },
    @Req() req: { actor: Actor },
  ): Promise<unknown> {
    const conflictId = assertUuid(id, 'id');
    const resolution = body?.resolution;
    if (resolution !== 'servidor' && resolution !== 'cliente' && resolution !== 'manual') {
      throw new BadRequestException('resolution debe ser servidor, cliente o manual');
    }
    if (resolution === 'manual' && (body.patch === null || typeof body.patch !== 'object')) {
      throw new BadRequestException('La resolución manual requiere patch');
    }
    return this.sync.resolveConflict(req.actor, conflictId, resolution, body.patch);
  }
}
