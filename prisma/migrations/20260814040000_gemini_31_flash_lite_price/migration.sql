INSERT INTO "analysis_model_prices" (
  "provider", "model", "effective_from", "effective_until",
  "input_per_million_usd", "cache_read_per_million_usd", "cache_write_per_million_usd",
  "output_per_million_usd", "pricing_source_url", "verified_at", "updated_at"
) VALUES (
  'google', 'gemini-3.1-flash-lite', '2026-05-07T00:00:00Z', NULL,
  0.250000, 0.025000, NULL, 1.500000,
  'https://ai.google.dev/gemini-api/docs/pricing', '2026-08-14T00:00:00Z', CURRENT_TIMESTAMP
);
