import { IsOptional, IsString, IsUrl } from 'class-validator';

// Only update is allowed here — creation happens automatically at first
// registration (see AuthService.register / findOrCreateTenant).
export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  tenantName?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  apiUrl?: string;
}
