import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { loadEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { ProbeModule } from './probe/probe.module';

const env = loadEnv();

@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    DatabaseModule,
    HealthModule,
    ...(env.allowDevActor ? [ProbeModule] : []),
  ],
})
export class AppModule {}
