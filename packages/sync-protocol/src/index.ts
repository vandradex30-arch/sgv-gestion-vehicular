// Contrato push/pull entre dispositivo y servidor (se implementa en la Etapa 2).

export type OperationKind = 'create' | 'update' | 'delete';

export interface PushOperation {
  /** UUID generado al abrir el formulario: reenviarlo nunca duplica el registro. */
  operationId: string;
  entityType: string;
  entityId: string;
  kind: OperationKind;
  /** Versión del servidor sobre la que se editó (null en creaciones). */
  baseVersion: number | null;
  /** Solo los campos cambiados. */
  patch: Record<string, unknown>;
  clientUpdatedAt: string;
  /** Orden monótono por dispositivo: garantiza que el padre llegue antes que el hijo. */
  deviceSeq: number;
}

export interface PushRequest {
  deviceId: string;
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
  | { operationId: string; result: 'aplicada'; version: number; serverSeq: number }
  | { operationId: string; result: 'duplicada'; version: number; serverSeq: number }
  | { operationId: string; result: 'conflicto'; conflictId: string; conflictType: ConflictType }
  | { operationId: string; result: 'rechazada'; reason: string }
  | { operationId: string; result: 'cuarentena'; quarantineId: string };

export interface PushResponse {
  results: OperationResult[];
}

export interface PullRequest {
  deviceId: string;
  sinceSeq: number;
  limit: number;
}

export interface PullChange {
  entityType: string;
  entityId: string;
  version: number;
  serverSeq: number;
  /** Eliminación lógica: se envía como registro con deletedAt. */
  record: Record<string, unknown>;
}

export interface PullResponse {
  changes: PullChange[];
  nextSeq: number;
  hasMore: boolean;
  /** Si el cursor es más viejo que la retención, el cliente debe hacer descarga completa. */
  requiresFullResync: boolean;
}

export const SYNC_ERROR_CODES = ['TOKEN_EXPIRED', 'DEVICE_REVOKED', 'SCHEMA_OUTDATED'] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];
