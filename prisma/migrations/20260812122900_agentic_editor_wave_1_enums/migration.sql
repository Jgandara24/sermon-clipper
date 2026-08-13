-- PostgreSQL requires a newly added enum value to commit before another migration can use it in
-- an index predicate. Keep this enum expansion immediately before the Wave 1 substrate migration.

-- CreateEnum
CREATE TYPE "render_qc_status" AS ENUM ('passed', 'failed');

-- CreateEnum
CREATE TYPE "publish_attempt_state" AS ENUM ('intent', 'succeeded', 'failed', 'indeterminate');

-- CreateEnum
CREATE TYPE "editorial_exception_state" AS ENUM ('open', 'resolved');

-- AlterEnum
ALTER TYPE "generated_clip_status" ADD VALUE 'superseded';

-- AlterEnum
ALTER TYPE "schedule_publish_status" ADD VALUE 'blocked';
ALTER TYPE "schedule_publish_status" ADD VALUE 'unfilled';
ALTER TYPE "schedule_publish_status" ADD VALUE 'missed';

-- AlterEnum
ALTER TYPE "service_slot" ADD VALUE 'unmatched';
