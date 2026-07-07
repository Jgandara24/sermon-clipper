CREATE TABLE "worker_heartbeats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "worker_id" TEXT NOT NULL,
    "hostname" TEXT,
    "pid" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "worker_heartbeats_worker_id_key" ON "worker_heartbeats"("worker_id");
CREATE INDEX "worker_heartbeats_last_seen_at_idx" ON "worker_heartbeats"("last_seen_at");
