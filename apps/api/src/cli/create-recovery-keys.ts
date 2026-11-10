/**
 * Genera el par de llaves de recuperación de la organización.
 * - RECOVERY_PUBLIC_KEY: se entrega a los dispositivos al iniciar sesión.
 * - RECOVERY_PRIVATE_KEY: SECRETA. Solo la conoce el servidor; con ella se abren los paquetes de recuperación.
 * Uso: pnpm --filter @sgv/api build && pnpm --filter @sgv/api create-recovery-keys
 * Copia ambas líneas a la configuración del servidor (nunca al repositorio) y guarda una copia de la privada
 * en un lugar seguro: sin ella, los paquetes de recuperación ya exportados no se pueden abrir.
 */
import { generateKeyPairSync } from 'crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

console.log(`RECOVERY_PUBLIC_KEY=${publicKey.toString('base64')}`);
console.log(`RECOVERY_PRIVATE_KEY="${privateKey.replace(/\n/g, '\\n')}"`);
