/** Quién hace la petición. Con sesión real viene del JWT; sessionId solo existe en ese caso. */
export interface Actor {
  userId: string;
  organizationId: string;
  deviceId?: string | null;
  sessionId?: string | null;
}

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

export abstract class ActorResolver {
  abstract resolve(req: RequestLike): Actor | null;
}
