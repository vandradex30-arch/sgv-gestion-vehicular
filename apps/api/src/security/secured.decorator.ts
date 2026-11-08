import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { TenantTransactionInterceptor } from '../database/tenant-transaction.interceptor';
import { PERMISSION_KEY, SessionPermissionInterceptor } from './session-permission.interceptor';

/**
 * Protege un endpoint: exige sesión válida y, si se indican, el permiso recurso:acción.
 * Abre la transacción con el contexto del usuario (RLS) y verifica en el servidor.
 */
export function Secured(resource?: string, action?: string) {
  const decorators: Array<ClassDecorator | MethodDecorator | PropertyDecorator> = [
    UseInterceptors(TenantTransactionInterceptor, SessionPermissionInterceptor),
  ];
  if (resource && action) {
    decorators.push(SetMetadata(PERMISSION_KEY, { resource, action }));
  }
  return applyDecorators(...decorators);
}
