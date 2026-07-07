-- CreateTable
CREATE TABLE "operational_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID,
    "category" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "project_id" UUID,
    "job_id" UUID,
    "export_job_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operational_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operational_events_workspace_id_created_at_idx" ON "operational_events"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "operational_events_category_created_at_idx" ON "operational_events"("category", "created_at");

-- CreateIndex
CREATE INDEX "operational_events_severity_created_at_idx" ON "operational_events"("severity", "created_at");

-- CreateIndex
CREATE INDEX "operational_events_project_id_idx" ON "operational_events"("project_id");

-- CreateIndex
CREATE INDEX "operational_events_job_id_idx" ON "operational_events"("job_id");

-- CreateIndex
CREATE INDEX "operational_events_export_job_id_idx" ON "operational_events"("export_job_id");

-- AddForeignKey
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
