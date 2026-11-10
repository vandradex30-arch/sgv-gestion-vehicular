import { b64decode, b64encode, randomBytes, toArrayBuffer } from './bytes';
import type { OperationKind } from './protocol';

export interface RecoveryOp {
  operationId: string;
  entityType: string;
  entityId: string;
  kind: OperationKind;
  baseVersion: number | null;
  /** La versión base se habría tomado al enviar (había otro cambio anterior sobre el mismo registro). */
  baseFromPrevious: boolean;
  patch: Record<string, unknown>;
  clientUpdatedAt: string;
  deviceSeq: number;
  status: 'pendiente' | 'enviada' | 'conflicto' | 'rechazada';
  conflictType?: string;
  reason?: string;
}

export interface RecoveryPayload {
  v: 1;
  orgId: string;
  userId: string;
  deviceId: string;
  createdAt: string;
  ops: RecoveryOp[];
}

/** Paquete cifrado con la llave pública de la organización: solo la llave privada del servidor lo abre. */
export interface RecoveryBundle {
  v: 1;
  alg: 'RSA-OAEP-256+A256GCM';
  wrappedKey: string;
  iv: string;
  data: string;
}

export const RECOVERY_AAD = 'sgv-recovery-v1';

export async function createRecoveryBundle(
  payload: RecoveryPayload,
  publicKeySpkiBase64: string,
): Promise<RecoveryBundle> {
  const subtle = globalThis.crypto.subtle;
  const encoder = new TextEncoder();
  const publicKey = await subtle.importKey(
    'spki',
    toArrayBuffer(b64decode(publicKeySpkiBase64)),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  // Llave de un solo uso: cifra el contenido y luego se envuelve con la llave de la organización.
  const aesKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = randomBytes(12);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(encoder.encode(RECOVERY_AAD)) },
    aesKey,
    toArrayBuffer(encoder.encode(JSON.stringify(payload))),
  );
  const rawKey = await subtle.exportKey('raw', aesKey);
  const wrapped = await subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey);
  return {
    v: 1,
    alg: 'RSA-OAEP-256+A256GCM',
    wrappedKey: b64encode(new Uint8Array(wrapped)),
    iv: b64encode(iv),
    data: b64encode(new Uint8Array(ciphertext)),
  };
}
