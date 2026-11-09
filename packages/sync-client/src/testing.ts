// Ayudas para pruebas: IndexedDB en memoria. No forma parte del paquete publicado.
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

export const memoryDb = {
  indexedDB: indexedDB as unknown as IDBFactory,
  IDBKeyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
};

/** Parámetros de derivación de clave livianos para que las pruebas sean rápidas. */
export const FAST_KDF = { memoryKiB: 1024, iterations: 1, parallelism: 1 };
