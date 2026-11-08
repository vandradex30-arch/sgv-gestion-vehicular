import { BadRequestException } from '@nestjs/common';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function field(body: unknown, key: string): unknown {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
}

export function requireString(body: unknown, key: string, min: number, max: number): string {
  const value = field(body, key);
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new BadRequestException(`${key} inválido`);
  }
  return value;
}

export function requireUuid(body: unknown, key: string): string {
  const value = field(body, key);
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new BadRequestException(`${key} inválido`);
  }
  return value.toLowerCase();
}

export function requireEmail(body: unknown, key: string): string {
  const value = requireString(body, key, 3, 254).trim().toLowerCase();
  if (!EMAIL_RE.test(value)) {
    throw new BadRequestException(`${key} inválido`);
  }
  return value;
}

export function assertUuid(value: string, name: string): string {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(`${name} inválido`);
  }
  return value.toLowerCase();
}

export function optionalString(body: unknown, key: string, max: number): string | undefined {
  const value = field(body, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new BadRequestException(`${key} inválido`);
  }
  return value;
}
