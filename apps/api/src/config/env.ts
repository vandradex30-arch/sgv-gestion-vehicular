export const ENV = Symbol('ENV');

export interface Env {
  nodeEnv: string;
  port: number;
  databaseUrlApp: string;
  poolMax: number;
  allowDevActor: boolean;
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  maxFailedAttempts: number;
  lockMinutes: number;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? 'development';
  const databaseUrlApp = source.DATABASE_URL_APP;
  if (!databaseUrlApp) {
    throw new Error('DATABASE_URL_APP es obligatorio');
  }
  const jwtSecret = source.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET es obligatorio y debe tener al menos 32 caracteres');
  }
  const allowDevActor = source.ALLOW_DEV_ACTOR === 'true';
  if (allowDevActor && nodeEnv === 'production') {
    throw new Error('ALLOW_DEV_ACTOR no puede activarse en producción');
  }
  return {
    nodeEnv,
    port: Number(source.PORT ?? 3000),
    databaseUrlApp,
    poolMax: Number(source.DB_POOL_MAX ?? 10),
    allowDevActor,
    jwtSecret,
    accessTtlSeconds: Number(source.ACCESS_TTL_SECONDS ?? 900),
    refreshTtlDays: Number(source.REFRESH_TTL_DAYS ?? 30),
    maxFailedAttempts: Number(source.MAX_FAILED_ATTEMPTS ?? 5),
    lockMinutes: Number(source.LOCK_MINUTES ?? 15),
  };
}
