// Tipos compartidos entre cliente y servidor (Etapa 0: solo vocabulario común).

export const ROLE_CODES = [
  'admin_general',
  'logistica',
  'vehiculos',
  'combustible',
  'generadores',
  'conductor_operador',
  'auditor',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const PERMISSION_ACTIONS = ['read', 'create', 'update', 'validate', 'approve', 'export'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_SCOPES = ['all', 'assigned', 'own'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export const WORKFLOW_STATUSES = ['borrador', 'en_revision', 'devuelto', 'validado', 'aprobado'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const SYNC_STATUSES = ['pendiente', 'sincronizado', 'conflicto'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const WORKFLOW_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  borrador: ['en_revision'],
  en_revision: ['validado', 'devuelto'],
  validado: ['aprobado', 'devuelto'],
  devuelto: ['en_revision'],
  aprobado: [],
};

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

/** Un registro aprobado queda bloqueado; solo cambia por solicitud de corrección autorizada. */
export function isLocked(status: WorkflowStatus): boolean {
  return status === 'aprobado';
}

/** Columnas comunes de toda tabla sincronizable (fechas en ISO 8601). */
export interface BaseRecord {
  id: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
  clientCreatedAt: string;
  clientUpdatedAt: string;
  createdBy: string;
  updatedBy: string;
  createdDeviceId: string;
  updatedDeviceId: string;
  version: number;
  serverSeq: number | null;
  deletedAt: string | null;
  deletedBy: string | null;
  deleteReason: string | null;
}

/** Columnas de flujo de validación. */
export interface WorkflowColumns {
  workflowStatus: WorkflowStatus;
  submittedAt: string | null;
  submittedBy: string | null;
  validatedAt: string | null;
  validatedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  returnedAt: string | null;
  returnedBy: string | null;
  returnReason: string | null;
  lockedAt: string | null;
  folio: string | null;
}
