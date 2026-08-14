UPDATE "analysis_model_prices"
SET "cache_read_per_million_usd" = 0.010000,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "provider" = 'google'
  AND "model" = 'gemini-2.5-flash-lite'
  AND "effective_from" = '2026-01-01T00:00:00Z';
