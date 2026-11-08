import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Actor } from './actor';
import { PG_POOL } from './tokens';

const CLIENT_KEY = 'tenant.pgClient';

/**
 * Único camino para consultar datos de negocio. Cada petición corre en UNA transacción
 * con el contexto del usuario fijado por set_config(..., true) (local a la transacción),
 * de modo que las políticas RLS ven siempre al usuario correcto aunque el pool reutilice
 * conexiones. Los repositorios usan query(); nunca el pool directo.
 */
@Injectable()
export class TenantDb {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly cls: ClsService,
  ) {}

  async runInTransaction<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      try {
        await client.query('SELECT app.set_context($1::uuid, $2::uuid, $3::uuid)', [
          actor.userId,
          actor.organizationId,
          actor.deviceId ?? null,
        ]);
        this.cls.set(CLIENT_KEY, client);
        const result = await fn();
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true; // conexión en mal estado: se descarta en vez de volver al pool
        }
        throw err;
      } finally {
        this.cls.set(CLIENT_KEY, undefined);
      }
    } catch (err) {
      discard = discard || !client;
      throw err;
    } finally {
      client.release(discard);
    }
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const client = this.cls.get<PoolClient | undefined>(CLIENT_KEY);
    if (!client) {
      throw new Error(
        'No hay transacción de tenant activa: toda consulta de negocio debe pasar por TenantTransactionInterceptor',
      );
    }
    return client.query<R>(text, params);
  }
}
