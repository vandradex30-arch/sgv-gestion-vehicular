import type { Enc } from './crypto';
import type { OperationKind, PushOperation } from './protocol';

export type SyncStatus = 'pendiente' | 'sincronizado' | 'conflicto';
export type OpStatus = 'pendiente' | 'enviada' | 'conflicto' | 'rechazada' | 'confirmada';

/** Metadatos que fija el servidor. */
export interface ServerMeta {
  version: number;
  serverSeq: number;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdDeviceId: string | null;
  updatedDeviceId: string | null;
  deletedAt: string | null;
  deleteReason: string | null;
}

/** Contenido cifrado de un registro. */
export interface RecordPlain {
  fields: Record<string, unknown>;
  server: ServerMeta | null;
  /** Últimos campos de negocio conocidos del servidor (para descartar cambios locales). */
  baseFields: Record<string, unknown> | null;
  dirtyFields: string[];
  lastError: string | null;
  conflictId: string | null;
  createdAtLocal: string;
  updatedAtLocal: string;
}

/** Contenido cifrado de una operación en cola. */
export interface OpPlain {
  patch: Record<string, unknown>;
  baseVersion: number | null;
  /** La versión base se toma al enviar (hay una operación anterior sobre el mismo registro). */
  baseFromPrevious: boolean;
  clientUpdatedAt: string;
  conflictId?: string;
  conflictType?: string;
  conflictFields?: string[];
  reason?: string;
}

/** Fila tal como queda en IndexedDB: solo los campos de índice están en claro. */
export interface RecordRow {
  entityType: string;
  id: string;
  syncStatus: SyncStatus;
  deleted: 0 | 1;
  enc: Enc;
}

export interface OutboxRow {
  operationId: string;
  deviceSeq: number;
  status: OpStatus;
  entityType: string;
  entityId: string;
  kind: OperationKind;
  attempts: number;
  confirmedAt?: number;
  enc: Enc;
}

export interface ConflictRow {
  id: string;
  status: string;
  enc: Enc;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

/** Registro descifrado, tal como lo ve la interfaz. */
export interface LocalRecord {
  entityType: string;
  id: string;
  fields: Record<string, unknown>;
  server: ServerMeta | null;
  syncStatus: SyncStatus;
  deleted: boolean;
  dirtyFields: string[];
  lastError: string | null;
  conflictId: string | null;
  createdAtLocal: string;
  updatedAtLocal: string;
}

export interface BatchItem {
  operationId: string;
  entityType: string;
  entityId: string;
  kind: OperationKind;
  op: PushOperation;
}

export interface StoreStats {
  /** Operaciones que contienen trabajo del usuario aún no confirmado por el servidor. */
  pending: number;
  conflicts: number;
}

export interface SyncReport {
  status: 'ok' | 'offline';
  applied: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  pulled: number;
}
