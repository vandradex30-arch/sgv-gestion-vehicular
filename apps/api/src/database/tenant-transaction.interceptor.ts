import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { from, lastValueFrom, Observable } from 'rxjs';
import { ActorResolver } from './actor';
import { TenantDb } from './tenant-db.service';

@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(
    private readonly db: TenantDb,
    private readonly actors: ActorResolver,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const actor = this.actors.resolve(req);
    if (!actor) {
      throw new UnauthorizedException();
    }
    req.actor = actor;
    return from(
      this.db.runInTransaction(actor, () => lastValueFrom(next.handle(), { defaultValue: undefined })),
    );
  }
}
