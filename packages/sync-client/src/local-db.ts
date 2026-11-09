import Dexie, { Table } from 'dexie';
import type { ConflictRow, MetaRow, OutboxRow, RecordRow } from './types';

export interface DbFactories {
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof IDBKeyRange;
}

/**
 * Base local de un usuario en un dispositivo. Solo los campos usados como índice están en claro
 * (tipo, id, estado de sincronización, eliminado); todo el contenido va cifrado en `enc`.
 */
export class SgvDb extends Dexie {
  meta!: Table<MetaRow, string>;
  records!: Table<RecordRow, [string, string]>;
  outbox!: Table<OutboxRow, string>;
  conflicts!: Table<ConflictRow, string>;

  constructor(name: string, factories: DbFactories = {}) {
    super(name, { indexedDB: factories.indexedDB, IDBKeyRange: factories.IDBKeyRange });
    this.version(1).stores({
      meta: 'key',
      records: '[entityType+id], entityType, syncStatus, deleted',
      outbox: 'operationId, deviceSeq, status, [entityType+entityId]',
      conflicts: 'id, status',
    });
  }
}
