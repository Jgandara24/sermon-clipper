-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "stripe_customer_id" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "stripe_subscription_id" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "stripe_subscription_status" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "stripe_price_id" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "stripe_current_period_end" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_stripe_customer_id_key" ON "workspaces"("stripe_customer_id");
CREATE UNIQUE INDEX "workspaces_stripe_subscription_id_key" ON "workspaces"("stripe_subscription_id");

-- CreateTable
CREATE TABLE "stripe_webhook_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_period_credits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "stripe_invoice_id" TEXT NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "plan_code" TEXT NOT NULL,
    "minutes_granted" DECIMAL(10,2) NOT NULL,
    "ledger_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_period_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_period_credits_stripe_invoice_id_key" ON "billing_period_credits"("stripe_invoice_id");
CREATE INDEX "billing_period_credits_workspace_id_created_at_idx" ON "billing_period_credits"("workspace_id", "created_at");
CREATE INDEX "billing_period_credits_stripe_subscription_id_idx" ON "billing_period_credits"("stripe_subscription_id");

-- AddForeignKey
ALTER TABLE "billing_period_credits" ADD CONSTRAINT "billing_period_credits_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing_period_credits" ADD CONSTRAINT "billing_period_credits_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "usage_ledger"("id") ON DELETE SET NULL ON UPDATE CASCADE;
