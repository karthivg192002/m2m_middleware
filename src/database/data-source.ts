import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { TenantMaster } from './entities/tenant-master.entity';
import { UserTenantMapping } from './entities/user-tenant-mapping.entity';

config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'password',
  database: process.env.DB_NAME ?? 'mtm_middleware',
  entities: [TenantMaster, UserTenantMapping],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
});
