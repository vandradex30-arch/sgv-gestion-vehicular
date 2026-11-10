import { Module } from '@nestjs/common';
import { QuarantineController } from './quarantine.controller';
import { QuarantineService } from './quarantine.service';

@Module({ controllers: [QuarantineController], providers: [QuarantineService] })
export class QuarantineModule {}
