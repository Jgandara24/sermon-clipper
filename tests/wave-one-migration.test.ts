import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260812123000_agentic_editor_wave_1/migration.sql",
);
const enumMigrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260812122900_agentic_editor_wave_1_enums/migration.sql",
);

describe("agentic editor Wave 1 migration contract", () => {
  it("commits schedule enum expansion before the partial index migration", () => {
    const sql = readFileSync(enumMigrationPath, "utf8");
    expect(sql).toContain(`ALTER TYPE "schedule_publish_status" ADD VALUE 'blocked';`);
    expect(sql).toContain(`ALTER TYPE "schedule_publish_status" ADD VALUE 'unfilled';`);
    expect(sql).toContain(`ALTER TYPE "schedule_publish_status" ADD VALUE 'missed';`);
    expect(sql).not.toContain("scheduled_posts_one_non_missed_date_idx");
  });

  it("uses the exact one-non-MISSED-date constraint", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain(`CREATE UNIQUE INDEX "scheduled_posts_one_non_missed_date_idx"
ON "scheduled_posts" ("workspace_id", "scheduled_date")
WHERE "publish_status" <> 'missed'::"schedule_publish_status";`);
  });

  it("backfills project ownership only from a live clip", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain(
      'UPDATE "scheduled_posts" AS sp\nSET "project_id" = clips."project_id"\nFROM "generated_clips" AS clips\nWHERE sp."clip_id" = clips."id";',
    );
    expect(sql).toContain('ADD COLUMN "project_id" UUID');
  });

  it("keeps historical edit identity and QC facts nullable", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain('ADD COLUMN "edit_version" INTEGER');
    expect(sql).toContain('ADD COLUMN "qc_status" "render_qc_status"');
    expect(sql).toContain('ADD COLUMN "qc_checksum" TEXT');
  });

  it("does not contain Prisma's invalid generated-tsvector rewrite", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).not.toContain('DROP INDEX "transcripts_search_vector_idx"');
    expect(sql).not.toContain('ALTER COLUMN "search_vector" DROP DEFAULT');
  });
});
