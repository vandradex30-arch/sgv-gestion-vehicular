import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Actor } from '../database/actor';
import { TenantDb } from '../database/tenant-db.service';
import { EntityDef, getEntity, projection, validatePatch, ENTITIES } from './entity-registry';
import type { OperationResult, Outcome, PullChange, PullResult, PushOperation } from './sync.types';

interface StoredOperation {
  operation_id: string;
  result: 'aplicada' | 'conflicto' | 'rechazada';
  resulting_version: number | null;
  server_seq: string | null;
  conflict_id: string | null;
  reason: string | null;
}

interface ConflictRow {
  id: string;
  entity_type: string;
  entity_id: string;
  conflict_type: string;
  kind: 'create' | 'update' | 'delete';
  user_id: string;
  status: string;
  client_patch: Record<string, unknown>;
  conflicting_fields: string[] | null;
}

type Row = Record<string, unknown>;

const REQUIRED_ACTION = { create: 'create', update: 'update', delete: 'approve' } as const;

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

@Injectable()
export class SyncService {
  constructor(private readonly db: TenantDb) {}

  // ===================================================================== PUSH
  async push(actor: Actor, operations: PushOperation[]): Promise<OperationResult[]> {
    if (!actor.deviceId) {
      throw new ForbiddenException('La sincronización requiere un dispositivo registrado');
    }
    const results: OperationResult[] = [];
    for (const op of operations) {
      results.push(await this.processOperation(actor, op));
    }
    return results;
  }

  private async processOperation(actor: Actor, op: PushOperation): Promise<OperationResult> {
    const stored = await this.findStored(op.operationId);
    if (stored) return this.replay(op.operationId, stored);

    await this.db.query('SAVEPOINT sync_op');
    let outcome: Outcome;
    try {
      outcome = await this.apply(op);
    } catch (err) {
      await this.db.query('ROLLBACK TO SAVEPOINT sync_op');
      if (pgCode(err) === '42501') {
        outcome = { kind: 'conflict', type: 'permiso', serverVersion: null, snapshot: null, fields: [] };
      } else {
        await this.db.query('RELEASE SAVEPOINT sync_op');
        throw err;
      }
    }

    try {
      const result = await this.record(actor, op, outcome);
      await this.db.query('RELEASE SAVEPOINT sync_op');
      return result;
    } catch (err) {
      await this.db.query('ROLLBACK TO SAVEPOINT sync_op');
      await this.db.query('RELEASE SAVEPOINT sync_op');
      if (pgCode(err) === '23505') {
        // Otra petición registró esta misma operación a la vez: se devuelve su resultado.
        const again = await this.findStored(op.operationId);
        return again
          ? this.replay(op.operationId, again)
          : { operationId: op.operationId, result: 'rechazada', reason: 'operation_id_en_uso' };
      }
      throw err;
    }
  }

  private async findStored(operationId: string): Promise<StoredOperation | undefined> {
    const result = await this.db.query<StoredOperation>(
      `SELECT operation_id, result, resulting_version, server_seq, conflict_id, reason
         FROM public.sync_operations WHERE operation_id = $1`,
      [operationId],
    );
    return result.rows[0];
  }

  private async replay(operationId: string, stored: StoredOperation): Promise<OperationResult> {
    if (stored.result === 'aplicada') {
      return {
        operationId,
        result: 'duplicada',
        version: stored.resulting_version ?? 0,
        serverSeq: Number(stored.server_seq ?? 0),
      };
    }
    if (stored.result === 'conflicto' && stored.conflict_id) {
      const conflict = (
        await this.db.query<{ conflict_type: string; conflicting_fields: string[] | null }>(
          'SELECT conflict_type, conflicting_fields FROM public.sync_conflicts WHERE id = $1',
          [stored.conflict_id],
        )
      ).rows[0];
      return {
        operationId,
        result: 'conflicto',
        conflictId: stored.conflict_id,
        conflictType: conflict?.conflict_type ?? 'version',
        conflictingFields: conflict?.conflicting_fields ?? [],
      };
    }
    return { operationId, result: 'rechazada', reason: stored.reason ?? 'rechazada' };
  }

  /** Guarda la operación (y su conflicto, si lo hay) para que reintentarla sea seguro. */
  private async record(actor: Actor, op: PushOperation, outcome: Outcome): Promise<OperationResult> {
    let conflictId: string | null = null;
    if (outcome.kind === 'conflict') {
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO public.sync_conflicts
           (organization_id, entity_type, entity_id, conflict_type, operation_id, kind, device_id, user_id,
            server_version, client_base_version, server_snapshot, client_patch, conflicting_fields)
         VALUES (app.organization_id(), $1, $2, $3, $4, $5, app.device_id(), app.user_id(),
                 $6, $7, $8::jsonb, $9::jsonb, $10)
         RETURNING id`,
        [
          op.entityType,
          op.entityId,
          outcome.type,
          op.operationId,
          op.kind,
          outcome.serverVersion,
          op.baseVersion,
          outcome.snapshot === null ? null : JSON.stringify(outcome.snapshot),
          JSON.stringify(op.patch ?? {}),
          outcome.fields,
        ],
      );
      conflictId = inserted.rows[0].id;
    }

    await this.db.query(
      `INSERT INTO public.sync_operations
         (operation_id, organization_id, device_id, user_id, device_seq, entity_type, entity_id, kind,
          base_version, result, resulting_version, server_seq, conflict_id, reason, merged, payload)
       VALUES ($1, app.organization_id(), app.device_id(), app.user_id(), $2, $3, $4, $5,
               $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        op.operationId,
        op.deviceSeq,
        op.entityType,
        op.entityId,
        op.kind,
        op.baseVersion,
        outcome.kind === 'applied' ? 'aplicada' : outcome.kind === 'conflict' ? 'conflicto' : 'rechazada',
        outcome.kind === 'applied' ? outcome.version : null,
        outcome.kind === 'applied' ? outcome.serverSeq : null,
        conflictId,
        outcome.kind === 'rejected' ? outcome.reason : null,
        outcome.kind === 'applied' ? outcome.merged : false,
        JSON.stringify({ patch: op.patch ?? {}, clientUpdatedAt: op.clientUpdatedAt }),
      ],
    );

    if (outcome.kind === 'applied') {
      return {
        operationId: op.operationId,
        result: 'aplicada',
        version: outcome.version,
        serverSeq: outcome.serverSeq,
        merged: outcome.merged,
      };
    }
    if (outcome.kind === 'conflict') {
      return {
        operationId: op.operationId,
        result: 'conflicto',
        conflictId: conflictId as string,
        conflictType: outcome.type,
        conflictingFields: outcome.fields,
      };
    }
    return { operationId: op.operationId, result: 'rechazada', reason: outcome.reason };
  }

  // ============================================================== aplicar un cambio
  private async apply(op: PushOperation): Promise<Outcome> {
    const def = getEntity(op.entityType);
    if (!def) return { kind: 'rejected', reason: 'entidad_desconocida' };

    const action = REQUIRED_ACTION[op.kind];
    const scope = (
      await this.db.query<{ scope: string | null }>('SELECT app.permission_scope($1, $2) AS scope', [
        def.resource,
        action,
      ])
    ).rows[0]?.scope;
    // Los alcances parciales se resuelven con las asignaciones (Etapa 3): por ahora se exige alcance total.
    if (scope !== 'all') {
      return { kind: 'conflict', type: 'permiso', serverVersion: null, snapshot: null, fields: [] };
    }

    switch (op.kind) {
      case 'create':
        return this.applyCreate(def, op);
      case 'update':
        return this.applyUpdate(def, op);
      case 'delete':
        return this.applyDelete(def, op);
      default:
        return { kind: 'rejected', reason: 'operacion_invalida' };
    }
  }

  private async lockCurrent(def: EntityDef, id: string): Promise<Row | undefined> {
    const result = await this.db.query<Row>(
      `SELECT ${projection(def)} FROM public.${def.table} WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0];
  }

  private async applyCreate(def: EntityDef, op: PushOperation): Promise<Outcome> {
    if (op.baseVersion !== null) return { kind: 'rejected', reason: 'base_version_invalida' };
    const { values, error } = validatePatch(def, op.patch, 'create');
    if (error) return { kind: 'rejected', reason: error };

    const existing = await this.lockCurrent(def, op.entityId);
    if (existing) {
      return {
        kind: 'conflict',
        type: 'version',
        serverVersion: Number(existing.version),
        snapshot: existing,
        fields: ['id'],
      };
    }

    const keys = Object.keys(values);
    const columns = keys.map((k) => def.fields[k].column);
    const params: unknown[] = [op.entityId, ...keys.map((k) => values[k]), op.clientUpdatedAt];
    const clientAt = `$${params.length}`;
    const inserted = await this.db.query<{ version: number; server_seq: string }>(
      `INSERT INTO public.${def.table} (id, organization_id, ${columns.join(', ')}, client_created_at, client_updated_at)
       VALUES ($1, app.organization_id(), ${keys.map((_, i) => `$${i + 2}`).join(', ')}, ${clientAt}, ${clientAt})
       ON CONFLICT DO NOTHING
       RETURNING version, server_seq`,
      params,
    );
    if (inserted.rows[0]) {
      return {
        kind: 'applied',
        version: inserted.rows[0].version,
        serverSeq: Number(inserted.rows[0].server_seq),
        merged: false,
      };
    }

    // Choque de unicidad (por ejemplo, misma patente): duplicado probable, lo decide una persona.
    const conditions = def.uniqueFields.map((f, i) => `${def.fields[f].column} = $${i + 1}`).join(' AND ');
    const duplicate = (
      await this.db.query<Row>(
        `SELECT ${projection(def)} FROM public.${def.table} WHERE deleted_at IS NULL AND ${conditions} LIMIT 1`,
        def.uniqueFields.map((f) => values[f]),
      )
    ).rows[0];
    if (!duplicate) return { kind: 'rejected', reason: 'conflicto_de_unicidad' };
    return {
      kind: 'conflict',
      type: 'duplicado_probable',
      serverVersion: Number(duplicate.version),
      snapshot: duplicate,
      fields: def.uniqueFields,
    };
  }

  private async applyUpdate(def: EntityDef, op: PushOperation): Promise<Outcome> {
    if (op.baseVersion === null) return { kind: 'rejected', reason: 'base_version_requerida' };
    const { values, error } = validatePatch(def, op.patch, 'update');
    if (error) return { kind: 'rejected', reason: error };

    const current = await this.lockCurrent(def, op.entityId);
    if (!current) return { kind: 'rejected', reason: 'no_existe' };
    const currentVersion = Number(current.version);
    if (current.deletedAt) {
      return { kind: 'conflict', type: 'eliminado_remoto', serverVersion: currentVersion, snapshot: current, fields: [] };
    }
    if (op.baseVersion > currentVersion) return { kind: 'rejected', reason: 'base_version_futura' };

    // Solo cuentan los campos cuyo valor realmente cambia.
    const effective = Object.keys(values).filter((k) => values[k] !== (current[k] ?? null));
    if (effective.length === 0) {
      return { kind: 'applied', version: currentVersion, serverSeq: Number(current.serverSeq), merged: false };
    }

    let merged = false;
    if (op.baseVersion < currentVersion) {
      const changedColumns = (
        await this.db.query<{ cols: string[] }>('SELECT app.fields_changed_since($1, $2, $3) AS cols', [
          def.table,
          op.entityId,
          op.baseVersion,
        ])
      ).rows[0]?.cols ?? [];
      const clashing = effective.filter(
        (k) => changedColumns.includes(def.fields[k].column) && !def.fields[k].lww,
      );
      if (clashing.length > 0) {
        return { kind: 'conflict', type: 'version', serverVersion: currentVersion, snapshot: current, fields: clashing };
      }
      merged = true;
    }
    return this.writeUpdate(def, op.entityId, values, effective, op.clientUpdatedAt, merged);
  }

  private async writeUpdate(
    def: EntityDef,
    id: string,
    values: Record<string, unknown>,
    keys: string[],
    clientUpdatedAt: string,
    merged: boolean,
  ): Promise<Outcome> {
    const params: unknown[] = [id, ...keys.map((k) => values[k]), clientUpdatedAt];
    const assignments = keys.map((k, i) => `${def.fields[k].column} = $${i + 2}`);
    assignments.push(`client_updated_at = $${params.length}`);
    // Subtransacción propia: un choque de unicidad (por ejemplo, cambiar a una patente ya usada)
    // se informa como rechazo sin abortar el resto de la petición.
    await this.db.query('SAVEPOINT sync_upd');
    try {
      const updated = await this.db.query<{ version: number; server_seq: string }>(
        `UPDATE public.${def.table} SET ${assignments.join(', ')} WHERE id = $1 RETURNING version, server_seq`,
        params,
      );
      await this.db.query('RELEASE SAVEPOINT sync_upd');
      if (!updated.rows[0]) return { kind: 'rejected', reason: 'no_existe' };
      return {
        kind: 'applied',
        version: updated.rows[0].version,
        serverSeq: Number(updated.rows[0].server_seq),
        merged,
      };
    } catch (err) {
      await this.db.query('ROLLBACK TO SAVEPOINT sync_upd');
      await this.db.query('RELEASE SAVEPOINT sync_upd');
      if (pgCode(err) === '23505') return { kind: 'rejected', reason: 'conflicto_de_unicidad' };
      throw err;
    }
  }

  private async applyDelete(def: EntityDef, op: PushOperation): Promise<Outcome> {
    if (op.baseVersion === null) return { kind: 'rejected', reason: 'base_version_requerida' };
    const reasonRaw = (op.patch as Record<string, unknown> | undefined)?.deleteReason;
    if (reasonRaw !== undefined && (typeof reasonRaw !== 'string' || reasonRaw.length > 200)) {
      return { kind: 'rejected', reason: 'delete_reason_invalido' };
    }
    const current = await this.lockCurrent(def, op.entityId);
    if (!current) return { kind: 'rejected', reason: 'no_existe' };
    const currentVersion = Number(current.version);
    if (current.deletedAt) {
      return { kind: 'applied', version: currentVersion, serverSeq: Number(current.serverSeq), merged: false };
    }
    if (op.baseVersion !== currentVersion) {
      // Eliminar algo que otra persona modificó: siempre lo decide una persona.
      return { kind: 'conflict', type: 'version', serverVersion: currentVersion, snapshot: current, fields: ['deletedAt'] };
    }
    const updated = await this.db.query<{ version: number; server_seq: string }>(
      `UPDATE public.${def.table}
          SET deleted_at = now(), delete_reason = $2, client_updated_at = $3
        WHERE id = $1 RETURNING version, server_seq`,
      [op.entityId, (reasonRaw as string | undefined) ?? null, op.clientUpdatedAt],
    );
    return {
      kind: 'applied',
      version: updated.rows[0].version,
      serverSeq: Number(updated.rows[0].server_seq),
      merged: false,
    };
  }

  // ===================================================================== PULL
  async pull(actor: Actor, sinceSeq: number, limit: number, pendingOpsCount?: number): Promise<PullResult> {
    const all: PullChange[] = [];
    for (const def of Object.values(ENTITIES)) {
      const scope = (
        await this.db.query<{ scope: string | null }>('SELECT app.permission_scope($1, $2) AS scope', [
          def.resource,
          'read',
        ])
      ).rows[0]?.scope;
      if (scope !== 'all') continue; // alcances parciales: Etapa 3
      const rows = await this.db.query<Row>(
        `SELECT ${projection(def)} FROM public.${def.table}
          WHERE organization_id = app.organization_id() AND server_seq > $1
          ORDER BY server_seq LIMIT $2`,
        [sinceSeq, limit + 1],
      );
      for (const row of rows.rows) {
        all.push({
          entityType: def.type,
          entityId: String(row.id),
          version: Number(row.version),
          serverSeq: Number(row.serverSeq),
          record: { ...row, serverSeq: Number(row.serverSeq) },
        });
      }
    }
    all.sort((a, b) => a.serverSeq - b.serverSeq);
    const page = all.slice(0, limit);
    const hasMore = all.length > limit;

    if (actor.deviceId) {
      await this.db.query(
        `UPDATE public.devices
            SET last_pulled_seq = GREATEST(last_pulled_seq, $1),
                pending_ops_count = COALESCE($2, pending_ops_count),
                last_seen_at = now()
          WHERE id = app.device_id()`,
        [sinceSeq, pendingOpsCount ?? null],
      );
    }
    return {
      changes: page,
      nextSeq: page.length > 0 ? page[page.length - 1].serverSeq : sinceSeq,
      hasMore,
      requiresFullResync: false,
    };
  }

  // ============================================================== conflictos
  async listConflicts(status: string): Promise<unknown[]> {
    const result = await this.db.query(
      `SELECT id, entity_type AS "entityType", entity_id AS "entityId", conflict_type AS "conflictType",
              kind, user_id AS "userId", server_version AS "serverVersion",
              client_base_version AS "clientBaseVersion", server_snapshot AS "serverSnapshot",
              client_patch AS "clientPatch", conflicting_fields AS "conflictingFields",
              status, resolution, created_at AS "createdAt"
         FROM public.sync_conflicts WHERE status = $1 ORDER BY created_at, id`,
      [status],
    );
    return result.rows;
  }

  async resolveConflict(
    actor: Actor,
    conflictId: string,
    resolution: 'servidor' | 'cliente' | 'manual',
    manualPatch: unknown,
  ): Promise<{ id: string; status: 'resuelto'; resolution: string; record: Row | null }> {
    const conflict = (
      await this.db.query<ConflictRow>('SELECT * FROM public.sync_conflicts WHERE id = $1 FOR UPDATE', [conflictId])
    ).rows[0];
    if (!conflict) throw new NotFoundException();
    if (conflict.status !== 'abierto') throw new ConflictException('El conflicto ya fue resuelto');

    const scope = (
      await this.db.query<{ scope: string | null }>('SELECT app.permission_scope($1, $2) AS scope', [
        'conflict',
        'resolve',
      ])
    ).rows[0]?.scope;
    const isOwner = conflict.user_id === actor.userId;
    // El alcance "assigned" (su área) se trata como propio hasta que existan las áreas (Etapas 3 a 5).
    if (!scope || (scope !== 'all' && !isOwner)) {
      throw new ForbiddenException('No puedes resolver este conflicto');
    }

    let record: Row | null = null;
    if (resolution !== 'servidor') {
      record = await this.applyResolution(conflict, resolution, manualPatch);
    }

    await this.db.query(
      `UPDATE public.sync_conflicts
          SET status = 'resuelto', resolution = $2, resolved_by = app.user_id(), resolved_at = now()
        WHERE id = $1`,
      [conflictId, resolution],
    );
    await this.db.query(
      `SELECT app.log_event(app.organization_id(), app.user_id(), app.device_id(),
                            'CONFLICT_RESOLVED', 'sync_conflicts', $1, $2::jsonb)`,
      [conflictId, JSON.stringify({ resolution, conflictType: conflict.conflict_type })],
    );
    return { id: conflictId, status: 'resuelto', resolution, record };
  }

  private async applyResolution(
    conflict: ConflictRow,
    resolution: 'cliente' | 'manual',
    manualPatch: unknown,
  ): Promise<Row | null> {
    if (conflict.conflict_type === 'duplicado_probable' || conflict.conflict_type === 'eliminado_remoto') {
      throw new BadRequestException('Este conflicto solo puede resolverse aceptando la versión del servidor');
    }
    const def = getEntity(conflict.entity_type);
    if (!def) throw new BadRequestException('Entidad desconocida');
    if (conflict.kind === 'create') {
      throw new BadRequestException('Un conflicto de creación solo puede resolverse con la versión del servidor');
    }

    const action = REQUIRED_ACTION[conflict.kind];
    const scope = (
      await this.db.query<{ scope: string | null }>('SELECT app.permission_scope($1, $2) AS scope', [
        def.resource,
        action,
      ])
    ).rows[0]?.scope;
    if (scope !== 'all') throw new ForbiddenException('No tienes permiso para aplicar este cambio');

    const current = await this.lockCurrent(def, conflict.entity_id);
    if (!current) throw new NotFoundException();
    if (current.deletedAt) throw new ConflictException('El registro ya fue eliminado');
    const now = new Date().toISOString();

    if (conflict.kind === 'delete') {
      if (resolution === 'manual') throw new BadRequestException('Una baja no admite edición manual');
      const reason = (conflict.client_patch as Record<string, unknown>)?.deleteReason;
      await this.db.query(
        `UPDATE public.${def.table} SET deleted_at = now(), delete_reason = $2, client_updated_at = $3 WHERE id = $1`,
        [conflict.entity_id, typeof reason === 'string' ? reason : null, now],
      );
    } else {
      const patch = resolution === 'cliente' ? conflict.client_patch : manualPatch;
      const { values, error } = validatePatch(def, patch, 'update');
      if (error) throw new BadRequestException(error);
      const keys = Object.keys(values).filter((k) => values[k] !== (current[k] ?? null));
      if (keys.length > 0) {
        const outcome = await this.writeUpdate(def, conflict.entity_id, values, keys, now, false);
        if (outcome.kind === 'rejected') throw new ConflictException(outcome.reason);
      }
    }
    const after = await this.lockCurrent(def, conflict.entity_id);
    return after ?? null;
  }
}
