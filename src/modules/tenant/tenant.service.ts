import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfig } from '../../config/configuration';
import { TenantMaster } from '../../database/entities/tenant-master.entity';
import { UserTenantMapping } from '../../database/entities/user-tenant-mapping.entity';
import { assertPublicHttpsApiUrl } from '../../common/utils/ssrf-guard';
import { UpdateTenantDto } from './dto/update-tenant.dto';

@Injectable()
export class TenantService {
  constructor(
    @InjectRepository(TenantMaster)
    private readonly tenantRepo: Repository<TenantMaster>,
    @InjectRepository(UserTenantMapping)
    private readonly mappingRepo: Repository<UserTenantMapping>,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  async listTenants(): Promise<TenantMaster[]> {
    return this.tenantRepo.find({ order: { createdAt: 'ASC' } });
  }

  async getTenant(id: string): Promise<TenantMaster> {
    const tenant = await this.tenantRepo.findOne({ where: { id } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  async updateTenant(id: string, dto: UpdateTenantDto): Promise<TenantMaster> {
    const tenant = await this.getTenant(id);
    if (dto.tenantName !== undefined) {
      tenant.tenantName = dto.tenantName;
    }
    if (dto.apiUrl !== undefined) {
      const ssrfConfig = this.configService.get('ssrf', { infer: true });
      await assertPublicHttpsApiUrl(dto.apiUrl, ssrfConfig.allowPrivateApiUrls);
      tenant.apiUrl = dto.apiUrl;
    }
    return this.tenantRepo.save(tenant);
  }

  async deactivateTenant(id: string): Promise<TenantMaster> {
    const tenant = await this.getTenant(id);
    tenant.isActive = false;
    return this.tenantRepo.save(tenant);
  }

  async listMappings(): Promise<UserTenantMapping[]> {
    return this.mappingRepo.find({ relations: ['tenant'], order: { createdAt: 'ASC' } });
  }

  async deactivateMapping(id: string): Promise<UserTenantMapping> {
    const mapping = await this.mappingRepo.findOne({ where: { id } });
    if (!mapping) {
      throw new NotFoundException('Mapping not found');
    }
    mapping.isActive = false;
    return this.mappingRepo.save(mapping);
  }
}
