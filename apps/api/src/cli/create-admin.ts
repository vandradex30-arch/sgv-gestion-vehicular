/**
 * Crea la organización inicial y su Administrador general.
 * Uso: DATABASE_URL_OWNER=... ADMIN_EMAIL=... ADMIN_PASSWORD=... [ORG_NAME=...] pnpm --filter @sgv/api create-admin
 * Se conecta como dueño de las tablas (no pasa por la API). La contraseña no se guarda en ningún archivo.
 */
import * as argon2 from 'argon2';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_OWNER;
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const orgName = process.env.ORG_NAME ?? 'Organización';
  if (!url || !email || !password) {
    throw new Error('Faltan DATABASE_URL_OWNER, ADMIN_EMAIL o ADMIN_PASSWORD');
  }
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD debe tener al menos 12 caracteres');
  }
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const org = await client.query<{ id: string }>('INSERT INTO public.organizations (name) VALUES ($1) RETURNING id', [
      orgName,
    ]);
    const user = await client.query<{ id: string }>(
      `INSERT INTO public.users (organization_id, email, full_name, password_hash)
       VALUES ($1, $2, 'Administrador general', $3) RETURNING id`,
      [org.rows[0].id, email, hash],
    );
    const role = await client.query<{ id: string }>("SELECT id FROM public.roles WHERE code = 'admin_general'");
    await client.query(
      'INSERT INTO public.user_roles (organization_id, user_id, role_id) VALUES ($1, $2, $3)',
      [org.rows[0].id, user.rows[0].id, role.rows[0].id],
    );
    await client.query('COMMIT');
    console.log(`Organización ${org.rows[0].id} y administrador ${email} creados.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
