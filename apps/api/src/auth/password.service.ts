import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Gasta el mismo tiempo que una verificación real cuando el correo no existe. */
  async verifyDummy(password: string): Promise<void> {
    if (!this.dummyHash) {
      this.dummyHash = this.hash(randomBytes(16).toString('hex'));
    }
    await this.verify(await this.dummyHash, password);
  }
}
