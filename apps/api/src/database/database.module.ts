import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { ENV, Env, loadEnv } from '../config/env';
import { ActorResolver } from './actor';
import { ChainedActorResolver, DevActorResolver, JwtActorResolver } from './actor-resolvers';
import { TenantDb } from './tenant-db.service';
import { TenantTransactionInterceptor } from './tenant-transaction.interceptor';
import { PG_POOL } from './tokens';

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: (): Env => loadEnv() },
    {
      provide: PG_POOL,
      inject: [ENV],
      useFactory: (env: Env) => new Pool({ connectionString: env.databaseUrlApp, max: env.poolMax }),
    },
    {
      provide: ActorResolver,
      inject: [ENV],
      useFactory: (env: Env): ActorResolver => {
        const jwtResolver = new JwtActorResolver(env.jwtSecret);
        return env.allowDevActor
          ? new ChainedActorResolver([jwtResolver, new DevActorResolver()])
          : jwtResolver;
      },
    },
    TenantDb,
    TenantTransactionInterceptor,
  ],
  exports: [ENV, PG_POOL, ActorResolver, TenantDb, TenantTransactionInterceptor],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
