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

export type Outcome =
  | { kind: 'applied'; version: number; serverSeq: number; merged: boolean }
  | {
      kind: 'conflict';
      type: string;
      serverVersion: number | null;
      snapshot: unknown;
      fields: string[];
    }
  | { kind: 'rejected'; reason: string };

export interface PullChange {
  entityType: string;
  entityId: string;
  version: number;
  serverSeq: number;
  record: Record<string, unknown>;
}

export interface PullResult {
  changes: PullChange[];
  nextSeq: number;
  hasMore: boolean;
  requiresFullResync: boolean;
}
