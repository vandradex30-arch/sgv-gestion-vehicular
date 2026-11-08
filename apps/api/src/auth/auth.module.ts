import { Module } from '@nestjs/common';
import { AuthController, MeController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, PasswordService, TokenService],
  exports: [PasswordService],
})
export class AuthModule {}
