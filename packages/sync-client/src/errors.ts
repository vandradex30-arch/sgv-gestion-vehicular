export class WrongSecretError extends Error {
  constructor() {
    super('Contraseña o PIN incorrecto');
    this.name = 'WrongSecretError';
  }
}

export class UnlockThrottledError extends Error {
  constructor(public readonly retryInMs: number) {
    super(`Demasiados intentos: espera ${Math.ceil(retryInMs / 1000)} s`);
    this.name = 'UnlockThrottledError';
  }
}

/** Tras demasiados intentos locales se exige iniciar sesión en línea. Nunca se borran datos por esto. */
export class ReauthRequiredError extends Error {
  constructor() {
    super('Se requiere iniciar sesión en línea para volver a intentar');
    this.name = 'ReauthRequiredError';
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super('Los datos locales están bloqueados');
    this.name = 'VaultLockedError';
  }
}

export class TamperError extends Error {
  constructor(what: string) {
    super(`Dato local alterado o ilegible: ${what}`);
    this.name = 'TamperError';
  }
}

export class PendingOperationsError extends Error {
  constructor(public readonly pending: number) {
    super(`Hay ${pending} registro(s) sin sincronizar: no se pueden borrar los datos locales`);
    this.name = 'PendingOperationsError';
  }
}

/** Sin conexión o servidor inalcanzable: las operaciones se conservan y se reintentan. */
export class NetworkError extends Error {
  constructor(message = 'Sin conexión') {
    super(message);
    this.name = 'NetworkError';
  }
}

export class SessionError extends Error {
  constructor(public readonly code: string) {
    super(`Sesión no válida: ${code}`);
    this.name = 'SessionError';
  }
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Pasó demasiado tiempo sin verificar la sesión en línea: los datos siguen intactos, pero hay que reconectar. */
export class GraceExpiredError extends Error {
  constructor() {
    super('Hace demasiado que no se verifica la sesión en línea: conéctate para continuar');
    this.name = 'GraceExpiredError';
  }
}

export class NoRecoveryKeyError extends Error {
  constructor() {
    super('Este dispositivo no tiene la llave de recuperación de la organización (se obtiene al iniciar sesión en línea)');
    this.name = 'NoRecoveryKeyError';
  }
}
