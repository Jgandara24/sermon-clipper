# Bounded Anthropic visual requests

`prepareAnthropicVisualBoundaryRequest` builds one image-and-text request without network work.
The caller must supply an exact model identifier, API key, policy version, limits, and price evidence.
The adapter does not read credentials or select a model from environment defaults.
The controlled PROBE entry does not enable this adapter.

The adapter accepts registered `SPARSE_FRAME`, `TIMELINE_VIEW`, and `BOUNDARY_STRIP` descriptors with verified WebP bytes.
Each descriptor includes an exact source timestamp, checksum, and byte count.
The adapter checks bytes and labels each image with its source timestamp.
It snapshots image and evidence content before returning the prepared request.
Later caller changes cannot change the message body.
Timeline images and boundary strips require the registered `proxy-contact-sheet-v2` cell map.
The source batch passes publication evidence to request preparation.
Callers read the map from that evidence and provide the matching image bytes.
A shared schema validates cell order, geometry, source timestamps, source interval, and empty-cell counts.
The image builder applies the same validation before publication.
The request includes cell coordinates, frame checksums, exact source timestamps, and empty-cell counts.
It states that empty cells contain no observations.
It does not treat sampled images as continuous coverage.
The prepared checksum binds both the map and the image bytes.

Anthropic documents base64 WebP input in its [vision guide](https://platform.claude.com/docs/en/build-with-claude/vision).
The request uses a fixed Messages API endpoint and rejects redirects.
It sends no tools, enables no prompt caching, and disables thinking.
The system instruction treats source words and images as evidence rather than instructions.
This instruction does not establish measured resistance to prompt injection.

## Reservation evidence

The adapter requires a model-specific maximum input-context ceiling and an evidence reference.
The reserved input allowance must cover that complete ceiling.
It does not use a character ratio or token-count estimate as a hard bound.
Anthropic describes context accounting in its [context-window documentation](https://platform.claude.com/docs/en/build-with-claude/context-windows).
The configured ceiling and prices still need independent production verification.
Prices must cover every applicable token tier for the selected model.
No context ceiling, model, token price, or service budget has been selected for production.

The ledger retains the context-ceiling evidence with its reservation.
It passes a checksum of the prepared configuration into dispatch.
The adapter checks that checksum, the body checksum, and the token limits before sending.
Changes to model identity, prices, or limits prevent dispatch.
The ledger remains responsible for one reservation per source.
The adapter also refuses a second dispatch from the same prepared instance.

## Response handling

The HTTP path makes one request and performs no automatic retries.
It bounds request bytes, image bytes, response bytes, and total elapsed time.
Timeouts abort the request.
Rate limits and server errors remain failures without another request.
The adapter rejects changed model identities, truncated output, refusals, missing usage, and unexpected cache charges.
The ledger retains uncertainty and blocks later paid requests.

The request uses a structured JSON output schema.
The adapter removes unsupported grammar constraints from that wire schema.
Full local validation still checks numeric bounds, required fields, and source intervals.
Anthropic lists its schema restrictions in the [structured-output documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations).

The model returns only its decision, source interval, confidence, and reason.
The adapter derives detector identity and evidence checksums locally.
It does not ask the model to invent provenance.
The confidence remains a model estimate; no calibration evidence exists.
The source batch separately checks permitted boundary changes and registers the final decision.

## Verification limits

Unit tests inject HTTP responses and never contact Anthropic.
The database integration uses real generated frames and an injected HTTP response.
It verifies reservation before dispatch, final-decision registration before Scribe, and response reuse on retry.
The integration sends one simulated visual request and one simulated Scribe request.
It does not establish real API acceptance, recognition accuracy, provider billing, or production readiness.

All 17 selected unit tests and ten selected database cases passed.
The final source-timestamp handoff also passed its focused database rerun.
Lint, application type checking, the worker build, and whitespace checks passed.
No real Anthropic request ran during these checks.

## Composite images in visual escalation — 2026-10-16

The Anthropic adapter now accepts registered timeline images and boundary strips.
A shared schema validates their source-time cell maps during image creation and request preparation.
It checks cell order, geometry, timestamps, source intervals, and empty-cell counts.
The source batch supplies registered publication evidence to the preparation callback.
The prepared request binds the image bytes and cell map into its checksum.
The prompt identifies empty cells and limits each cell to one sampled instant.

All 25 selected unit tests passed.
Generated-image tests verified both image types and unchanged request content after caller mutation.
Eleven boundary database cases passed on the first run.
The composite case initially failed because its fixture requested a timestamp between actual video frames.
The corrected composite case passed its focused rerun with actual frame timestamps.
It verified registered cell maps, one simulated visual request, final-decision publication, and reuse before Scribe.
Type checking, targeted lint, the worker build, and whitespace checks passed.
Both temporary databases stopped before their directories were removed.
No real provider request ran.

Production configuration, real API acceptance, and representative quality remain unfinished.
