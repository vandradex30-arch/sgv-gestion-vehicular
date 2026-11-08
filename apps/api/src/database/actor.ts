/** Quién hace la petición. En la Etapa 1 se obtiene del JWT y del dispositivo registrado. */
export interface Actor {
  userId: string;
  organizationId: string;
  deviceId?: string | null;
}

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

export abstract class ActorResolver {
  abstract resolve(req: RequestLike): Actor | null;
}
