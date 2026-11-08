import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

export const PASSWORD = 'Contraseña-segura-123';

export const uniq = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`;

export async function createOrg(owner: Pool, name: string): Promise<string> {
  const result = await owner.query<{ id: string }>(
    'INSERT INTO public.organizations (name) VALUES ($1) RETURNING id',
    [name],
  );
  return result.rows[0].id;
}

/** Crea un usuario saltándose la API (como lo haría el CLI de creación del primer administrador). */
export async function createUser(
  owner: Pool,
  orgId: string,
  roleCode: string,
  password: string = PASSWORD,
): Promise<{ id: string; email: string }> {
  const email = `${uniq(roleCode)}@test.cl`;
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const user = await owner.query<{ id: string }>(
    `INSERT INTO public.users (organization_id, email, full_name, password_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, email, `Usuario ${roleCode}`, hash],
  );
  await owner.query(
    `INSERT INTO public.user_roles (organization_id, user_id, role_id)
     SELECT $1, $2, id FROM public.roles WHERE code = $3`,
    [orgId, user.rows[0].id, roleCode],
  );
  return { id: user.rows[0].id, email };
}
