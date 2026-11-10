import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { loadEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { DevicesModule } from './devices/devices.module';
import { HealthModule } from './health/health.module';
import { ProbeModule } from './probe/probe.module';
import { QuarantineModule } from './quarantine/quarantine.module';
import { SyncModule } from './sync/sync.module';
import { UsersModule } from './users/users.module';

const env = loadEnv();

@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    DevicesModule,
    AuditModule,
    SyncModule,
    QuarantineModule,
    ...(env.allowDevActor ? [ProbeModule] : []),
  ],
})
export class AppModule {}
