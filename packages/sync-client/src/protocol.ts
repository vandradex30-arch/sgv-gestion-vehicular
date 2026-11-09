// Contrato push/pull con el servidor. Copia de packages/sync-protocol: mantener ambos iguales.

export type OperationKind = 'create' | 'update' | 'delete';

export interface PushOperation {
  operationId: string;
  entityType: string;
  entityId: string;
  kind: OperationKind;
  baseVersion: number | null;
  patch: Record<string, unknown>;
  clientUpdatedAt: string;
  deviceSeq: number;
}

export type OperationResult =
  | { operationId: string; result: 'aplicada'; version: number; serverSeq: number; merged: boolean }
  | { operationId: string; result: 'duplicada'; version: number; serverSeq: number }
  | {
      operationId: string;
      result: 'conflicto';
      conflictId: string;
      conflictType: string;
      conflictingFields: string[];
    }
  | { operationId: string; result: 'rechazada'; reason: string };

export interface PushResponse {
  results: OperationResult[];
}

export interface PullRequest {
  sinceSeq: number;
  limit?: number;
  pendingOpsCount?: number;
}

export interface PullChange {
  entityType: string;
  entityId: string;
  version: number;
  serverSeq: number;
  record: Record<string, unknown>;
}

export interface PullResponse {
  changes: PullChange[];
  nextSeq: number;
  hasMore: boolean;
  requiresFullResync: boolean;
}

export type ConflictResolution = 'servidor' | 'cliente' | 'manual';

export interface ServerConflict {
  id: string;
  entityType: string;
  entityId: string;
  conflictType: string;
  operationId: string;
  kind: OperationKind;
  userId: string;
  serverVersion: number | null;
  clientBaseVersion: number | null;
  serverSnapshot: Record<string, unknown> | null;
  clientPatch: Record<string, unknown>;
  conflictingFields: string[] | null;
  status: string;
  resolution: string | null;
  createdAt: string;
}

export interface ResolveResponse {
  id: string;
  status: 'resuelto';
  resolution: string;
  record: Record<string, unknown> | null;
}
