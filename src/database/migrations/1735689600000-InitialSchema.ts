import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1735689600000 implements MigrationInterface {
  name = 'InitialSchema1735689600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await queryRunner.query(`
      CREATE TABLE "tenant_master" (
        "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_name" VARCHAR(255) NOT NULL,
        "tenant_code" VARCHAR(100) NOT NULL UNIQUE,
        "api_url"     TEXT         NOT NULL,
        "is_active"   BOOLEAN      NOT NULL DEFAULT TRUE,
        "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "user_tenant_mapping" (
        "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        "username"    VARCHAR(255) NOT NULL UNIQUE,
        "tenant_id"   UUID         NOT NULL REFERENCES "tenant_master"("id") ON DELETE RESTRICT,
        "is_active"   BOOLEAN      NOT NULL DEFAULT TRUE,
        "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_user_tenant_mapping_tenant_id" ON "user_tenant_mapping" ("tenant_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_tenant_mapping"`);
    await queryRunner.query(`DROP TABLE "tenant_master"`);
  }
}
