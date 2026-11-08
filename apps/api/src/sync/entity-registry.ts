/**
 * Registro de entidades sincronizables. Cada entidad declara su tabla, sus campos permitidos
 * y sus reglas de validación; el motor de sincronización es genérico y solo trabaja con lo
 * declarado aquí (los identificadores SQL vienen siempre de este archivo, nunca del cliente).
 */
export interface FieldDef {
  column: string;
  kind: 'string' | 'int';
  min?: number;
  max?: number;
  pattern?: RegExp;
  upper?: boolean;
  nullable?: boolean;
  /** Texto libre: ante conflicto gana el último cambio recibido por el servidor. */
  lww?: boolean;
}

export interface EntityDef {
  type: string;
  table: string;
  /** Recurso de la matriz de permisos (vehicle, fuel_load, ...). */
  resource: string;
  fields: Record<string, FieldDef>;
  requiredOnCreate: string[];
  /** Campos cuya unicidad define un duplicado probable. */
  uniqueFields: string[];
}

export const ENTITIES: Record<string, EntityDef> = {
  vehicle: {
    type: 'vehicle',
    table: 'vehicles',
    resource: 'vehicle',
    fields: {
      plate: { column: 'plate', kind: 'string', min: 3, max: 12, pattern: /^[A-Z0-9-]+$/, upper: true },
      brand: { column: 'brand', kind: 'string', min: 1, max: 60, nullable: true },
      model: { column: 'model', kind: 'string', min: 1, max: 60, nullable: true },
      year: { column: 'vehicle_year', kind: 'int', min: 1950, max: 2100, nullable: true },
      notes: { column: 'notes', kind: 'string', min: 1, max: 500, nullable: true, lww: true },
    },
    requiredOnCreate: ['plate'],
    uniqueFields: ['plate'],
  },
};

export function getEntity(type: string): EntityDef | undefined {
  return Object.prototype.hasOwnProperty.call(ENTITIES, type) ? ENTITIES[type] : undefined;
}

const COMMON_COLUMNS: Array<[string, string]> = [
  ['id', 'id'],
  ['version', 'version'],
  ['server_seq', 'serverSeq'],
  ['created_at', 'createdAt'],
  ['updated_at', 'updatedAt'],
  ['client_created_at', 'clientCreatedAt'],
  ['client_updated_at', 'clientUpdatedAt'],
  ['created_by', 'createdBy'],
  ['updated_by', 'updatedBy'],
  ['created_device_id', 'createdDeviceId'],
  ['updated_device_id', 'updatedDeviceId'],
  ['deleted_at', 'deletedAt'],
  ['delete_reason', 'deleteReason'],
];

/** Lista de columnas con alias camelCase para leer un registro completo. */
export function projection(def: EntityDef): string {
  const common = COMMON_COLUMNS.map(([column, alias]) => `${column} AS "${alias}"`);
  const own = Object.entries(def.fields).map(([key, field]) => `${field.column} AS "${key}"`);
  return [...common, ...own].join(', ');
}

export interface ValidatedPatch {
  values: Record<string, unknown>;
  error?: string;
}

export function validatePatch(def: EntityDef, patch: unknown, kind: 'create' | 'update'): ValidatedPatch {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { values: {}, error: 'patch_invalido' };
  }
  const values: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(def.fields, key)) {
      return { values, error: `campo_no_permitido:${key}` };
    }
    const field = def.fields[key];
    if (raw === null) {
      if (!field.nullable) return { values, error: `campo_requerido:${key}` };
      values[key] = null;
      continue;
    }
    if (field.kind === 'string') {
      if (typeof raw !== 'string') return { values, error: `tipo_invalido:${key}` };
      let value = raw.trim();
      if (field.upper) value = value.toUpperCase();
      if (value.length < (field.min ?? 0) || value.length > (field.max ?? 10000)) {
        return { values, error: `longitud_invalida:${key}` };
      }
      if (field.pattern && !field.pattern.test(value)) return { values, error: `formato_invalido:${key}` };
      values[key] = value;
    } else {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return { values, error: `tipo_invalido:${key}` };
      if (raw < (field.min ?? -Infinity) || raw > (field.max ?? Infinity)) {
        return { values, error: `rango_invalido:${key}` };
      }
      values[key] = raw;
    }
  }
  if (kind === 'create') {
    for (const required of def.requiredOnCreate) {
      if (values[required] === undefined || values[required] === null) {
        return { values, error: `campo_requerido:${required}` };
      }
    }
  }
  return { values };
}
