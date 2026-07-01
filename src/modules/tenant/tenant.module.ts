import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantMaster } from '../../database/entities/tenant-master.entity';
import { UserTenantMapping } from '../../database/entities/user-tenant-mapping.entity';
import { TenantController } from './tenant.controller';
import { TenantService } from './tenant.service';

@Module({
  imports: [TypeOrmModule.forFeature([TenantMaster, UserTenantMapping])],
  controllers: [TenantController],
  providers: [TenantService],
})
export class TenantModule {}
