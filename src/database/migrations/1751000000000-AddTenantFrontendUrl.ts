import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTenantFrontendUrl1751000000000 implements MigrationInterface {
  name = 'AddTenantFrontendUrl1751000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenant_master" ADD COLUMN "frontend_url" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tenant_master" DROP COLUMN "frontend_url"`);
  }
}
