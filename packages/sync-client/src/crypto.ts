import { argon2id } from 'hash-wasm';
import { b64decode, b64encode, randomBytes, toArrayBuffer } from './bytes';
import { TamperError, WrongSecretError } from './errors';

/** Datos cifrados tal como se guardan en IndexedDB. */
export interface Enc {
  iv: Uint8Array;
  ct: Uint8Array;
}

export interface KdfParams {
  name: 'argon2id';
  salt: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export interface VaultData {
  v: 1;
  kdf: KdfParams;
  /** Clave de datos (DEK) cifrada con la clave derivada de la contraseña o PIN. */
  wrapped: Enc;
}

export interface KdfOptions {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** Valores de producción: ~19 MiB y 3 pasadas, aptos para equipos modestos. */
export const DEFAULT_KDF: KdfOptions = { memoryKiB: 19456, iterations: 3, parallelism: 1 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto no está disponible en este entorno');
  return c.subtle;
}

async function deriveKek(secret: string, kdf: KdfParams): Promise<CryptoKey> {
  const raw = await argon2id({
    password: secret,
    salt: b64decode(kdf.salt),
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memoryKiB,
    hashLength: 32,
    outputType: 'binary',
  });
  return subtle().importKey('raw', toArrayBuffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptBytes(key: CryptoKey, data: Uint8Array, aad: string): Promise<Enc> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(encoder.encode(aad)) },
    key,
    toArrayBuffer(data),
  );
  return { iv, ct: new Uint8Array(ct) };
}

async function decryptBytes(key: CryptoKey, enc: Enc, aad: string): Promise<Uint8Array> {
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(enc.iv), additionalData: toArrayBuffer(encoder.encode(aad)) },
    key,
    toArrayBuffer(enc.ct),
  );
  return new Uint8Array(plain);
}

/** Cifra un objeto ligándolo a su identidad (aad): un dato copiado a otro registro deja de descifrar. */
export async function encryptJson(dek: CryptoKey, value: unknown, aad: string): Promise<Enc> {
  return encryptBytes(dek, encoder.encode(JSON.stringify(value)), aad);
}

export async function decryptJson<T>(dek: CryptoKey, enc: Enc, aad: string): Promise<T> {
  try {
    return JSON.parse(decoder.decode(await decryptBytes(dek, enc, aad))) as T;
  } catch {
    throw new TamperError(aad);
  }
}

async function importDek(raw: Uint8Array): Promise<CryptoKey> {
  // No extraíble: el código de la aplicación puede usarla pero no exportarla.
  return subtle().importKey('raw', toArrayBuffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const VAULT_AAD = 'sgv-vault-v1';

export async function createVault(
  secret: string,
  options: Partial<KdfOptions> = {},
): Promise<{ vault: VaultData; dek: CryptoKey }> {
  const kdf: KdfParams = {
    name: 'argon2id',
    salt: b64encode(randomBytes(16)),
    memoryKiB: options.memoryKiB ?? DEFAULT_KDF.memoryKiB,
    iterations: options.iterations ?? DEFAULT_KDF.iterations,
    parallelism: options.parallelism ?? DEFAULT_KDF.parallelism,
  };
  const kek = await deriveKek(secret, kdf);
  const rawDek = randomBytes(32);
  const wrapped = await encryptBytes(kek, rawDek, VAULT_AAD);
  const dek = await importDek(rawDek);
  rawDek.fill(0);
  return { vault: { v: 1, kdf, wrapped }, dek };
}

export async function unlockVault(vault: VaultData, secret: string): Promise<CryptoKey> {
  const kek = await deriveKek(secret, vault.kdf);
  let raw: Uint8Array;
  try {
    raw = await decryptBytes(kek, vault.wrapped, VAULT_AAD);
  } catch {
    throw new WrongSecretError();
  }
  const dek = await importDek(raw);
  raw.fill(0);
  return dek;
}
