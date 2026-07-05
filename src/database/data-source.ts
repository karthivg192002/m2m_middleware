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
  // __dirname-relative with both extensions: resolves to src/migrations/*.ts
  // under ts-node (local dev: migration:generate/run/revert) and to
  // dist/migrations/*.js when run from the compiled output (production
  // entrypoint — see docker-entrypoint.sh) — same data source, both contexts.
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
});
