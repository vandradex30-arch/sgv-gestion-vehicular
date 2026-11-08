// Contrato push/pull entre dispositivo y servidor (Etapa 2a: lado servidor implementado).
// El dispositivo se identifica por el token de sesión: el cuerpo de las peticiones no lleva deviceId.

export type OperationKind = 'create' | 'update' | 'delete';

export interface PushOperation {
  /** UUID generado al abrir el formulario: reenviarlo nunca duplica el registro. */
  operationId: string;
  entityType: string;
  entityId: string;
  kind: OperationKind;
  /** Versión del servidor sobre la que se editó (null en creaciones; obligatoria en update y delete). */
  baseVersion: number | null;
  /** Solo los campos cambiados (en delete, opcionalmente { deleteReason }). */
  patch: Record<string, unknown>;
  clientUpdatedAt: string;
  /** Orden monótono por dispositivo: garantiza que el padre llegue antes que el hijo. */
  deviceSeq: number;
}

/** Máximo de operaciones por envío. */
export const MAX_PUSH_OPERATIONS = 50;

export interface PushRequest {
  operations: PushOperation[];
}

export const CONFLICT_TYPES = [
  'version',
  'bloqueado',
  'duplicado_probable',
  'solapamiento',
  'continuidad',
  'eliminado_remoto',
  'permiso',
  'dispositivo_revocado',
] as const;
export type ConflictType = (typeof CONFLICT_TYPES)[number];

export type OperationResult =
  | { operationId: string; result: 'aplicada'; version: number; serverSeq: number; merged: boolean }
  /** La operación ya se había aplicado antes (reintento): no se duplicó nada. */
  | { operationId: string; result: 'duplicada'; version: number; serverSeq: number }
  | {
      operationId: string;
      result: 'conflicto';
      conflictId: string;
      conflictType: ConflictType;
      conflictingFields: string[];
    }
  | { operationId: string; result: 'rechazada'; reason: string };

export interface PushResponse {
  results: OperationResult[];
}

export interface PullRequest {
  /** Último serverSeq que el dispositivo ya tiene. */
  sinceSeq: number;
  limit?: number;
  /** Operaciones aún sin confirmar en el dispositivo (telemetría para alertas de pendientes antiguos). */
  pendingOpsCount?: number;
}

export interface PullChange {
  entityType: string;
  entityId: string;
  version: number;
  serverSeq: number;
  /** Registro completo; una eliminación lógica llega con deletedAt. */
  record: Record<string, unknown>;
}

export interface PullResponse {
  changes: PullChange[];
  nextSeq: number;
  hasMore: boolean;
  /** Si el cursor es más viejo que la retención, el cliente debe hacer descarga completa. */
  requiresFullResync: boolean;
}

export type ConflictResolution = 'servidor' | 'cliente' | 'manual';

export const SYNC_ERROR_CODES = [
  'TOKEN_EXPIRED',
  'DEVICE_REVOKED',
  'SESSION_REVOKED',
  'SESSION_INVALID',
  'USER_DISABLED',
  'SCHEMA_OUTDATED',
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];
