CREATE TYPE "analysis_provider_kind" AS ENUM ('anthropic', 'openai', 'google', 'heuristic');
CREATE TYPE "analysis_routing_policy_state" AS ENUM ('draft', 'active', 'retired');
CREATE TYPE "workspace_access_plan" AS ENUM ('trial', 'paid');

ALTER TABLE "workspaces"
  ADD COLUMN "access_plan" "workspace_access_plan" NOT NULL DEFAULT 'trial',
  ADD COLUMN "trial_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "trial_ends_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  ADD COLUMN "paid_at" TIMESTAMP(3);

UPDATE "workspaces"
SET
  "trial_started_at" = "created_at",
  "trial_ends_at" = "created_at" + interval '30 days',
  "access_plan" = CASE
    WHEN "plan_code" IN ('starter', 'pro', 'dev') THEN 'paid'::"workspace_access_plan"
    ELSE 'trial'::"workspace_access_plan"
  END,
  "paid_at" = CASE
    WHEN "plan_code" IN ('starter', 'pro', 'dev') THEN "created_at"
    ELSE NULL
  END,
  "plan_code" = CASE
    WHEN "plan_code" IN ('starter', 'pro', 'dev') THEN 'paid'
    ELSE 'trial'
  END;

ALTER TABLE "workspaces" ALTER COLUMN "plan_code" SET DEFAULT 'trial';

CREATE TABLE "analysis_routing_policies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "version" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "state" "analysis_routing_policy_state" NOT NULL DEFAULT 'draft',
  "classification_provider" "analysis_provider_kind" NOT NULL,
  "classification_model" TEXT NOT NULL,
  "scoring_provider" "analysis_provider_kind" NOT NULL,
  "scoring_model" TEXT NOT NULL,
  "prompt_version" INTEGER NOT NULL DEFAULT 1,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "activated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "analysis_routing_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "analysis_routing_policies_version_key"
  ON "analysis_routing_policies"("version");
CREATE INDEX "analysis_routing_policies_state_version_idx"
  ON "analysis_routing_policies"("state", "version");
CREATE UNIQUE INDEX "analysis_routing_policies_one_active_idx"
  ON "analysis_routing_policies"(("state")) WHERE "state" = 'active';

CREATE TABLE "analysis_model_prices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider" "analysis_provider_kind" NOT NULL,
  "model" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "effective_from" TIMESTAMP(3) NOT NULL,
  "effective_until" TIMESTAMP(3),
  "input_per_million_usd" DECIMAL(12,6) NOT NULL,
  "cache_read_per_million_usd" DECIMAL(12,6),
  "cache_write_per_million_usd" DECIMAL(12,6),
  "output_per_million_usd" DECIMAL(12,6) NOT NULL,
  "pricing_source_url" TEXT NOT NULL,
  "verified_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "analysis_model_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "analysis_model_prices_provider_model_effective_from_key"
  ON "analysis_model_prices"("provider", "model", "effective_from");
CREATE INDEX "analysis_model_prices_provider_model_effective_from_idx"
  ON "analysis_model_prices"("provider", "model", "effective_from");

INSERT INTO "analysis_routing_policies" (
  "version", "name", "state", "classification_provider", "classification_model",
  "scoring_provider", "scoring_model", "prompt_version", "schema_version", "activated_at", "updated_at"
) VALUES (
  1, 'Claude production baseline', 'active', 'anthropic', 'claude-haiku-4-5',
  'anthropic', 'claude-sonnet-5', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO "analysis_model_prices" (
  "provider", "model", "effective_from", "effective_until",
  "input_per_million_usd", "cache_read_per_million_usd", "cache_write_per_million_usd",
  "output_per_million_usd", "pricing_source_url", "verified_at", "updated_at"
) VALUES
  ('anthropic', 'claude-haiku-4-5', '2026-01-01T00:00:00Z', NULL,
   1.000000, 0.100000, 1.250000, 5.000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-13T00:00:00Z', CURRENT_TIMESTAMP),
  ('anthropic', 'claude-sonnet-5', '2026-01-01T00:00:00Z', '2026-09-01T00:00:00Z',
   2.000000, 0.200000, 2.500000, 10.000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-13T00:00:00Z', CURRENT_TIMESTAMP),
  ('anthropic', 'claude-sonnet-5', '2026-09-01T00:00:00Z', NULL,
   3.000000, 0.300000, 3.750000, 15.000000,
   'https://platform.claude.com/docs/en/about-claude/pricing', '2026-08-13T00:00:00Z', CURRENT_TIMESTAMP),
  ('google', 'gemini-2.5-flash-lite', '2026-01-01T00:00:00Z', NULL,
   0.100000, NULL, NULL, 0.400000,
   'https://ai.google.dev/gemini-api/docs/pricing', '2026-08-13T00:00:00Z', CURRENT_TIMESTAMP);
