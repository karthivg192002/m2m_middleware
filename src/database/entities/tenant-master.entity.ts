import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserTenantMapping } from './user-tenant-mapping.entity';

@Entity('tenant_master')
export class TenantMaster {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_name', type: 'varchar', length: 255 })
  tenantName: string;

  @Index({ unique: true })
  @Column({ name: 'tenant_code', type: 'varchar', length: 100, unique: true })
  tenantCode: string;

  @Column({ name: 'api_url', type: 'text' })
  apiUrl: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => UserTenantMapping, (mapping) => mapping.tenant)
  mappings: UserTenantMapping[];
}
