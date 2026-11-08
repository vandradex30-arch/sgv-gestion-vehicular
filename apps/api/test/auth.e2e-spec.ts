import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { createOrg, createUser, PASSWORD } from './helpers';

jest.setTimeout(60000);

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;
const suite = OWNER_URL && APP_URL ? describe : describe.skip;

suite('Identidad, permisos, dispositivos y auditoría (PostgreSQL real)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let owner: Pool;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'prueba-jwt-secret-prueba-jwt-secret-0123456789';
    process.env.ALLOW_DEV_ACTOR = 'false';
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();
    owner = new Pool({ connectionString: OWNER_URL });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.end();
  });

  const login = (email: string, deviceId: string = randomUUID(), password: string = PASSWORD) =>
    request(http)
      .post('/auth/login')
      .send({ email, password, deviceId, deviceLabel: 'Equipo de prueba', platform: 'web' });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('inicia sesión y /me devuelve perfil y permisos', async () => {
    const org = await createOrg(owner, 'Org login');
    const admin = await createUser(owner, org, 'admin_general');
    const res = await login(admin.email).expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));

    const me = await request(http).get('/me').set(bearer(res.body.accessToken)).expect(200);
    expect(me.body.roles.map((r: { code: string }) => r.code)).toEqual(['admin_general']);
    expect(
      me.body.permissions.some(
        (p: { resource: string; action: string; scope: string }) =>
          p.resource === 'user' && p.action === 'manage' && p.scope === 'all',
      ),
    ).toBe(true);
  });

  it('rechaza contraseñas incorrectas y bloquea la cuenta tras los intentos fallidos', async () => {
    const org = await createOrg(owner, 'Org bloqueo');
    const user = await createUser(owner, org, 'conductor_operador');
    for (let i = 0; i < 5; i++) {
      await login(user.email, randomUUID(), 'clave-incorrecta-123').expect(401);
    }
    const locked = await login(user.email).expect(429);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('un correo inexistente recibe el mismo error genérico', async () => {
    const res = await login('no-existe@test.cl').expect(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('sin token no se accede a nada protegido', async () => {
    await request(http).get('/users').expect(401);
    await request(http).get('/me').expect(401);
    await request(http).get('/audit').expect(401);
  });

  it('el administrador crea usuarios y el conductor no puede', async () => {
    const org = await createOrg(owner, 'Org permisos');
    const admin = await createUser(owner, org, 'admin_general');
    const adminToken = (await login(admin.email).expect(200)).body.accessToken;

    const newEmail = `nuevo-${randomUUID().slice(0, 8)}@test.cl`;
    await request(http)
      .post('/users')
      .set(bearer(adminToken))
      .send({ email: newEmail, fullName: 'Nuevo Conductor', password: PASSWORD, roleCode: 'conductor_operador' })
      .expect(201);

    // clave demasiado corta y rol inexistente
    await request(http)
      .post('/users')
      .set(bearer(adminToken))
      .send({ email: `x-${randomUUID().slice(0, 8)}@test.cl`, fullName: 'X', password: 'corta', roleCode: 'conductor_operador' })
      .expect(400);
    await request(http)
      .post('/users')
      .set(bearer(adminToken))
      .send({ email: `y-${randomUUID().slice(0, 8)}@test.cl`, fullName: 'Y', password: PASSWORD, roleCode: 'inventado' })
      .expect(400);

    const driverToken = (await login(newEmail).expect(200)).body.accessToken;
    await request(http).get('/me').set(bearer(driverToken)).expect(200);
    await request(http)
      .post('/users')
      .set(bearer(driverToken))
      .send({ email: `z-${randomUUID().slice(0, 8)}@test.cl`, fullName: 'Z', password: PASSWORD, roleCode: 'admin_general' })
      .expect(403);
    await request(http).get('/users').set(bearer(driverToken)).expect(403);
    await request(http).get('/audit').set(bearer(driverToken)).expect(403);
  });

  it('cada organización ve solo a sus usuarios', async () => {
    const orgA = await createOrg(owner, 'Org A');
    const orgB = await createOrg(owner, 'Org B');
    const adminA = await createUser(owner, orgA, 'admin_general');
    const adminB = await createUser(owner, orgB, 'admin_general');
    const tokenA = (await login(adminA.email).expect(200)).body.accessToken;
    const tokenB = (await login(adminB.email).expect(200)).body.accessToken;

    const listA = await request(http).get('/users').set(bearer(tokenA)).expect(200);
    const listB = await request(http).get('/users').set(bearer(tokenB)).expect(200);
    expect(listA.body.map((u: { email: string }) => u.email)).toEqual([adminA.email]);
    expect(listB.body.map((u: { email: string }) => u.email)).toEqual([adminB.email]);
  });

  it('revocar un dispositivo corta sesión, renovación e inicio de sesión desde él', async () => {
    const org = await createOrg(owner, 'Org dispositivos');
    const admin = await createUser(owner, org, 'admin_general');
    const driver = await createUser(owner, org, 'conductor_operador');
    const adminToken = (await login(admin.email).expect(200)).body.accessToken;

    const deviceId = randomUUID();
    const driverLogin = (await login(driver.email, deviceId).expect(200)).body;
    await request(http).get('/me').set(bearer(driverLogin.accessToken)).expect(200);

    const devices = await request(http).get('/devices').set(bearer(adminToken)).expect(200);
    expect(devices.body.some((d: { id: string }) => d.id === deviceId)).toBe(true);

    await request(http).post(`/devices/${deviceId}/revoke`).set(bearer(adminToken)).send({}).expect(200);

    const afterRevoke = await request(http).get('/me').set(bearer(driverLogin.accessToken)).expect(401);
    expect(afterRevoke.body.code).toBe('DEVICE_REVOKED');
    await request(http).post('/auth/refresh').send({ refreshToken: driverLogin.refreshToken }).expect(401);
    const relogin = await login(driver.email, deviceId).expect(403);
    expect(relogin.body.code).toBe('DEVICE_REVOKED');

    // otro dispositivo del mismo usuario sigue funcionando
    await login(driver.email, randomUUID()).expect(200);
    // un conductor no puede revocar dispositivos
    const driverToken = (await login(driver.email, randomUUID()).expect(200)).body.accessToken;
    await request(http).post(`/devices/${randomUUID()}/revoke`).set(bearer(driverToken)).send({}).expect(403);
  });

  it('rota el refresh token y detecta su reutilización', async () => {
    const org = await createOrg(owner, 'Org refresh');
    const user = await createUser(owner, org, 'conductor_operador');
    const first = (await login(user.email).expect(200)).body;

    const second = (await request(http).post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200)).body;
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // la sesión anterior ya no sirve para nada
    await request(http).get('/me').set(bearer(first.accessToken)).expect(401);
    // reutilizar el token viejo es señal de robo: se invalida toda la cadena
    await request(http).post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await request(http).post('/auth/refresh').send({ refreshToken: second.refreshToken }).expect(401);
  });

  it('cerrar sesión invalida el token de acceso', async () => {
    const org = await createOrg(owner, 'Org logout');
    const user = await createUser(owner, org, 'conductor_operador');
    const tokens = (await login(user.email).expect(200)).body;
    await request(http).post('/auth/logout').send({ refreshToken: tokens.refreshToken }).expect(204);
    await request(http).get('/me').set(bearer(tokens.accessToken)).expect(401);
    await request(http).post('/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(401);
  });

  it('un usuario desactivado pierde el acceso de inmediato', async () => {
    const org = await createOrg(owner, 'Org desactivar');
    const admin = await createUser(owner, org, 'admin_general');
    const driver = await createUser(owner, org, 'conductor_operador');
    const adminToken = (await login(admin.email).expect(200)).body.accessToken;
    const driverToken = (await login(driver.email).expect(200)).body.accessToken;

    await request(http)
      .patch(`/users/${driver.id}/status`)
      .set(bearer(adminToken))
      .send({ status: 'inactivo' })
      .expect(200);
    const res = await request(http).get('/me').set(bearer(driverToken)).expect(401);
    expect(res.body.code).toBe('USER_DISABLED');
    await login(driver.email).expect(401);
    // el administrador no puede desactivarse a sí mismo
    await request(http).patch(`/users/${admin.id}/status`).set(bearer(adminToken)).send({ status: 'inactivo' }).expect(400);
  });

  it('la auditoría registra inicios de sesión y cambios, y solo la ven administrador y auditor', async () => {
    const org = await createOrg(owner, 'Org auditoría');
    const admin = await createUser(owner, org, 'admin_general');
    const auditor = await createUser(owner, org, 'auditor');
    const logistica = await createUser(owner, org, 'logistica');
    const adminToken = (await login(admin.email).expect(200)).body.accessToken;

    await request(http)
      .post('/users')
      .set(bearer(adminToken))
      .send({ email: `aud-${randomUUID().slice(0, 8)}@test.cl`, fullName: 'Para auditar', password: PASSWORD, roleCode: 'vehiculos' })
      .expect(201);

    const log = await request(http).get('/audit?limit=100').set(bearer(adminToken)).expect(200);
    const actions = log.body.map((r: { action: string; entityType: string }) => `${r.entityType}:${r.action}`);
    expect(actions).toContain('session:LOGIN');
    expect(actions).toContain('users:CREATE');
    expect(actions).toContain('user_roles:CREATE');

    const auditorToken = (await login(auditor.email).expect(200)).body.accessToken;
    await request(http).get('/audit').set(bearer(auditorToken)).expect(200);
    // el auditor no puede escribir en ninguna parte
    await request(http)
      .post('/users')
      .set(bearer(auditorToken))
      .send({ email: `no-${randomUUID().slice(0, 8)}@test.cl`, fullName: 'No', password: PASSWORD, roleCode: 'auditor' })
      .expect(403);
    // logística tiene alcance parcial sobre la auditoría: por ahora no ve nada de ella
    const logisticaToken = (await login(logistica.email).expect(200)).body.accessToken;
    await request(http).get('/audit').set(bearer(logisticaToken)).expect(200, []);

    const check = await owner.query<{ bad: string | null }>('SELECT app.verify_audit_chain($1) AS bad', [org]);
    expect(check.rows[0].bad).toBeNull();
  });
});
