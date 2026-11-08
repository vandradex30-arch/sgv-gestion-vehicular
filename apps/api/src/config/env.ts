export const ENV = Symbol('ENV');

export interface Env {
  nodeEnv: string;
  port: number;
  databaseUrlApp: string;
  poolMax: number;
  allowDevActor: boolean;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? 'development';
  const databaseUrlApp = source.DATABASE_URL_APP;
  if (!databaseUrlApp) {
    throw new Error('DATABASE_URL_APP es obligatorio');
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
  };
}
