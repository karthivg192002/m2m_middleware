import { Body, Controller, Delete, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../../common/guards/admin.guard';
import { TenantService } from './tenant.service';
import { UpdateTenantDto } from './dto/update-tenant.dto';

// Prefixed with "middleware/" so these can never collide with a forwarded
// main-service route — see IMPLEMENTATION_PLAN.md "Route Priority".
@Controller('middleware/admin')
@UseGuards(AdminGuard)
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Get('tenants')
  listTenants() {
    return this.tenantService.listTenants();
  }

  @Get('tenants/:id')
  getTenant(@Param('id') id: string) {
    return this.tenantService.getTenant(id);
  }

  @Patch('tenants/:id')
  updateTenant(@Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.tenantService.updateTenant(id, dto);
  }

  @Delete('tenants/:id')
  deactivateTenant(@Param('id') id: string) {
    return this.tenantService.deactivateTenant(id);
  }

  @Get('mappings')
  listMappings() {
    return this.tenantService.listMappings();
  }

  @Delete('mappings/:id')
  deactivateMapping(@Param('id') id: string) {
    return this.tenantService.deactivateMapping(id);
  }
}
