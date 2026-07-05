import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantMaster } from '../../database/entities/tenant-master.entity';

// Backs dynamic CORS: a newly self-registered tenant's frontend origin is
// allowed immediately (added here the moment its tenant_master row is
// created), not just origins baked into CORS_ORIGINS at deploy time. Seeded
// from every existing tenant's frontendUrl at boot so a restart doesn't lose
// previously-registered origins.
@Injectable()
export class TenantOriginRegistryService implements OnModuleInit {
  private readonly origins = new Set<string>();

  constructor(
    @InjectRepository(TenantMaster)
    private readonly tenantRepo: Repository<TenantMaster>,
  ) {}

  async onModuleInit(): Promise<void> {
    const tenants = await this.tenantRepo.find({ where: { isActive: true } });
    for (const tenant of tenants) {
      if (tenant.frontendUrl) this.add(tenant.frontendUrl);
    }
  }

  add(url: string): void {
    try {
      this.origins.add(new URL(url).origin);
    } catch {
      // Malformed URL — nothing sane to add; don't let a bad stored value
      // crash origin checks for every other request.
    }
  }

  has(origin: string): boolean {
    return this.origins.has(origin);
  }
}
