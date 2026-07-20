-- Publish history must survive clip regeneration: a SUCCEEDED scheduled post is the only
-- record a real Facebook post exists, and re-analysis deletes/recreates a project's clips.
ALTER TABLE "scheduled_posts" ALTER COLUMN "clip_id" DROP NOT NULL;
ALTER TABLE "scheduled_posts" DROP CONSTRAINT "scheduled_posts_clip_id_fkey";
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "generated_clips"("id") ON DELETE SET NULL ON UPDATE CASCADE;
