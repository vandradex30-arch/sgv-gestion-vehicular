import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;
const suite = OWNER_URL && APP_URL ? describe : describe.skip;

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_A = '11111111-0000-0000-0000-000000000001';
const USER_B = '22222222-0000-0000-0000-000000000002';

const actor = (org: string, user: string) => ({ 'x-dev-org-id': org, 'x-dev-user-id': user });

suite('RLS base (integración con PostgreSQL real)', () => {
  let app: INestApplication;
  let owner: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_DEV_ACTOR = 'true';
    process.env.JWT_SECRET = 'prueba-jwt-secret-prueba-jwt-secret-0123456789';
    // Un solo cliente en el pool: fuerza a reutilizar la conexión y prueba que el contexto no se filtra.
    process.env.DB_POOL_MAX = '1';
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    owner = new Pool({ connectionString: OWNER_URL });
    appPool = new Pool({ connectionString: APP_URL, max: 1 });
  });

  beforeEach(async () => {
    await owner.query('TRUNCATE public.rls_probe');
  });

  afterAll(async () => {
    await app?.close();
    await owner?.end();
    await appPool?.end();
  });

  async function inTx(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await fn(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('GET /health responde sin autenticación', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
  });

  it('rechaza con 401 las peticiones sin identidad', async () => {
    await request(app.getHttpServer()).get('/probe').expect(401);
  });

  it('cada organización ve solo sus registros', async () => {
    const http = app.getHttpServer();
    await request(http).post('/probe').set(actor(ORG_A, USER_A)).send({ note: 'a1' }).expect(201);
    await request(http).post('/probe').set(actor(ORG_B, USER_B)).send({ note: 'b1' }).expect(201);

    const a = await request(http).get('/probe').set(actor(ORG_A, USER_A)).expect(200);
    const b = await request(http).get('/probe').set(actor(ORG_B, USER_B)).expect(200);
    expect(a.body.map((r: { note: string }) => r.note)).toEqual(['a1']);
    expect(b.body.map((r: { note: string }) => r.note)).toEqual(['b1']);
  });

  it('el contexto no se filtra entre peticiones que reutilizan la misma conexión', async () => {
    const http = app.getHttpServer();
    await request(http).post('/probe').set(actor(ORG_A, USER_A)).send({ note: 'a1' }).expect(201);
    await request(http).post('/probe').set(actor(ORG_B, USER_B)).send({ note: 'b1' }).expect(201);

    for (let i = 0; i < 20; i++) {
      const [org, user, expected] = i % 2 === 0 ? [ORG_A, USER_A, 'a1'] : [ORG_B, USER_B, 'b1'];
      const res = await request(http).get('/probe').set(actor(org, user)).expect(200);
      expect(res.body.map((r: { note: string }) => r.note)).toEqual([expected]);
    }
  });

  it('la aplicación no puede insertar en otra organización', async () => {
    await inTx(async (client) => {
      await client.query('SELECT app.set_context($1, $2, NULL)', [USER_A, ORG_A]);
      await expect(
        client.query('INSERT INTO public.rls_probe (organization_id, owner_id, note) VALUES ($1, $2, $3)', [
          ORG_B,
          USER_A,
          'intruso',
        ]),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it('la aplicación no puede borrar filas', async () => {
    await inTx(async (client) => {
      await client.query('SELECT app.set_context($1, $2, NULL)', [USER_A, ORG_A]);
      await expect(client.query('DELETE FROM public.rls_probe')).rejects.toThrow(/permission denied/i);
    });
  });
});
