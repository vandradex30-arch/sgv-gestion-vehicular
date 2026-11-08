import { Module } from '@nestjs/common';
import { ProbeController } from './probe.controller';

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
