import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { constants, createDecipheriv, createHash, privateDecrypt } from 'crypto';
import { UUID_RE } from '../common/validation';
import { ENV, Env } from '../config/env';
import type { Actor } from '../database/actor';
import { TenantDb } from '../database/tenant-db.service';

const AAD = 'sgv-recovery-v1';
const MAX_BUNDLE_CHARS = 4_000_000;
const KINDS = ['create', 'update', 'delete'];

interface Bundle {
  v: number;
  alg: string;
  wrappedKey: string;
  iv: string;
  data: string;
}

interface Payload {
  v: number;
  orgId: string;
  userId: string;
  deviceId: string;
  createdAt: string;
  ops: Array<Record<string, unknown>>;
}

@Injectable()
export class QuarantineService {
  constructor(
    private readonly db: TenantDb,
    @Inject(ENV) private readonly env: Env,
  ) {}

  publicKey(): string | null {
    return this.env.recoveryPublicKeySpki;
  }

  private decrypt(bundle: unknown): Payload {
    if (!this.env.recoveryPrivateKeyPem) {
      throw new ServiceUnavailableException('La recuperación de dispositivos no está configurada en el servidor');
    }
    const b = bundle as Partial<Bundle> | null;
    if (
      !b ||
      b.v !== 1 ||
      b.alg !== 'RSA-OAEP-256+A256GCM' ||
      typeof b.wrappedKey !== 'string' ||
      typeof b.iv !== 'string' ||
      typeof b.data !== 'string' ||
      b.data.length > MAX_BUNDLE_CHARS
    ) {
      throw new BadRequestException('Paquete de recuperación inválido');
    }
    try {
      const aesKey = privateDecrypt(
        { key: this.env.recoveryPrivateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(b.wrappedKey, 'base64'),
      );
      const data = Buffer.from(b.data, 'base64');
      if (data.length < 17) throw new Error('corto');
      const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(b.iv, 'base64'));
      decipher.setAAD(Buffer.from(AAD));
      decipher.setAuthTag(data.subarray(data.length - 16));
      const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as Payload;
    } catch {
      // No se distingue la causa: un paquete alterado o de otra organización simplemente no abre.
      throw new BadRequestException('No se pudo abrir el paquete de recuperación');
    }
  }

  private validate(payload: Payload): void {
    const bad = (what: string): never => {
      throw new BadRequestException(`Paquete inválido: ${what}`);
    };
    if (payload.v !== 1) bad('versión');
    for (const key of ['orgId', 'userId', 'deviceId'] as const) {
      if (typeof payload[key] !== 'string' || !UUID_RE.test(payload[key])) bad(key);
    }
    if (!Array.isArray(payload.ops) || payload.ops.length < 1 || payload.ops.length > 500) bad('ops');
    for (const op of payload.ops) {
      if (
        typeof op.operationId !== 'string' ||
        !UUID_RE.test(op.operationId) ||
        typeof op.entityId !== 'string' ||
        !UUID_RE.test(op.entityId) ||
        typeof op.entityType !== 'string' ||
        typeof op.kind !== 'string' ||
        !KINDS.includes(op.kind) ||
        op.patch === null ||
        typeof op.patch !== 'object'
      ) {
        bad('operación');
      }
    }
  }

  async import(actor: Actor, bundle: unknown): Promise<{ id: string; opCount: number }> {
    const payload = this.decrypt(bundle);
    this.validate(payload);
    if (payload.orgId !== actor.organizationId) {
      throw new ForbiddenException('El paquete pertenece a otra organización');
    }
    const device = (
      await this.db.query<{ user_id: string }>('SELECT user_id FROM public.devices WHERE id = $1', [payload.deviceId])
    ).rows[0];
    if (!device || device.user_id !== payload.userId) {
      throw new BadRequestException('El dispositivo del paquete no corresponde a ese usuario');
    }

    const b = bundle as Bundle;
    const hash = createHash('sha256').update(`${b.iv}.${b.data}`).digest('hex');
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO public.sync_quarantine
         (organization_id, uploaded_by, source_user_id, source_device_id, bundle_hash, op_count, payload)
       VALUES (app.organization_id(), app.user_id(), $1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (organization_id, bundle_hash) DO NOTHING
       RETURNING id`,
      [payload.userId, payload.deviceId, hash, payload.ops.length, JSON.stringify(payload)],
    );
    if (!inserted.rows[0]) throw new ConflictException('Este paquete ya fue importado');
    const id = inserted.rows[0].id;
    await this.db.query(
      `SELECT app.log_event(app.organization_id(), app.user_id(), app.device_id(),
                            'QUARANTINE_IMPORT', 'sync_quarantine', $1, $2::jsonb)`,
      [id, JSON.stringify({ sourceUserId: payload.userId, sourceDeviceId: payload.deviceId, opCount: payload.ops.length })],
    );
    return { id, opCount: payload.ops.length };
  }

  async list(status: string): Promise<unknown[]> {
    const result = await this.db.query(
      `SELECT q.id, q.source_user_id AS "sourceUserId", u.email AS "sourceUserEmail",
              q.source_device_id AS "sourceDeviceId", q.op_count AS "opCount", q.status, q.note,
              q.uploaded_at AS "uploadedAt", q.reviewed_at AS "reviewedAt", q.payload
         FROM public.sync_quarantine q JOIN public.users u ON u.id = q.source_user_id
        WHERE q.status = $1 ORDER BY q.uploaded_at, q.id`,
      [status],
    );
    return result.rows;
  }

  async review(id: string, status: 'aceptada' | 'descartada', note: string | null): Promise<{ id: string; status: string }> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE public.sync_quarantine
          SET status = $2, note = $3, reviewed_by = app.user_id(), reviewed_at = now()
        WHERE id = $1 AND status = 'pendiente' RETURNING id`,
      [id, status, note],
    );
    if (!result.rows[0]) throw new NotFoundException('No existe o ya fue revisado');
    await this.db.query(
      `SELECT app.log_event(app.organization_id(), app.user_id(), app.device_id(),
                            'QUARANTINE_REVIEW', 'sync_quarantine', $1, $2::jsonb)`,
      [id, JSON.stringify({ status })],
    );
    return { id, status };
  }
}
