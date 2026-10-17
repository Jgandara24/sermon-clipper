# Durable visual boundary escalation

`runVisualBoundaryEscalationOnce` reserves one visual request per source.
The additive migration stores the reservation before the provider callback runs.
The source row lock serializes concurrent reservations.
A unique source identifier also prevents a second reservation in the database.
Changed settings, images, prompts, models, or prices cannot create another request for that source.

Admission requires the active derivative-build lease and matching workspace ownership.
It requires a retained, published boundary decision whose publication evidence explicitly records ambiguity.
Historical decision artifacts without that field do not qualify.
It accepts only retained representative frames, timeline images, or boundary strips from the same source bytes.
It rejects duplicate images and excessive image bytes.
The caller supplies an exact prepared-request checksum, provider, model, policy version, and price evidence reference.
The provider adapter must verify that its dispatched request matches those facts.

The budget uses integer micro-USD values.
The service calculates the maximum token charge with integer arithmetic and rounds upward.
It rejects reservations above the explicit budget before dispatch.
No provider price, token limit, or service budget has a default.
This reservation covers this visual request only.
It does not represent a complete service-processing budget.

States are `STARTED`, `COMPLETED`, and `UNCERTAIN`.
Completed requests retain their response, reported usage, request identifier, and result checksum.
Exact retries reuse the retained result without another callback.
Concurrent requests observe the existing reservation and cannot dispatch again.
Interrupted or uncertain requests never become new reservations because of age.
Provider failures and oversized responses retain an uncertain outcome.
The database prevents changes to request identity, budget, completed results, and reservation history.

A response above its reserved token limits remains recorded as completed evidence.
The service marks that response unusable and refuses it on later retries.
It never hides the overrun by discarding the reservation or sending another request.
Measured calls record their supplied token prices and reported usage.
Unknown outcomes remain unpriced.
These records do not claim verified provider billing.

Artifact cleanup retains source evidence while an escalation remains started or uncertain.
This hold also applies after project and artifact expiration.
The service has no automatic release or paid retry for an uncertain outcome.
Manual recovery still needs a separate reviewed procedure.

The callback must disable SDK retries and enforce its prepared input and output limits.
The service proves one callback admission per source; it does not prove an absent adapter's network behavior.
A bounded Anthropic adapter now exists with an injected-HTTP test.
No production model choice or real paid request was added.
The optional source-batch handoff now connects unresolved local decisions to this ledger.
The batch registers the final visual decision before sermon extraction or Scribe.
The controlled PROBE entry still does not enable this path.

Database tests use dummy artifact bytes and injected provider responses.
They cover concurrency, result reuse, uncertain responses, budgets, image limits, ownership, overruns, immutability, and retention holds.
Boundary-sampling database cases also exercise the new immutable ambiguity metadata.
The tests do not measure recognition quality, real provider billing, or production activation.

All 14 selected database cases and 14 selected unit tests passed.
The database run included nine escalation cases and five boundary-sampling regression cases.
Retention tests confirmed that expired evidence remains available after an uncertain escalation.
Lint, application type checking, the worker build, and whitespace checks passed.
The temporary database stopped before its directory was removed.

## Optional source-batch handoff

An internal caller can provide `prepareVisualEscalation` with the boundary-sampling request.
The callback prepares a bounded request and a separate provider submission function.
Request preparation must not send a paid request.
The batch invokes preparation only when the local decision remains ambiguous.
A resolved local decision never invokes visual preparation or submission.

The callback receives immutable evidence identities and available images from the current batch.
The batch rejects image identifiers that do not belong to that image set.
The batch supplies workspace, source, session, owner, and boundary-decision identities itself.
The ledger reserves the request before it invokes the submission function.
Successful retries reuse the same retained visual response and completed Scribe submission.

The batch validates the visual response against the existing resolution schema.
It rejects unsupported changes outside sampled boundary windows.
A valid result receives a `registered-visual-boundary-resolution-v1` artifact.
The document links the local decision, sampling evidence, escalation record, and exact escalation-result checksum.
A resolved final corridor binds its evidence checksum to this document.
Only then can sermon extraction and Scribe proceed.

Continued ambiguity, budget refusal, invalid responses, and provider failures create the existing human-review exception.
The exception includes the escalation identifier when a reservation exists.
Later requests stop at the open exception before another original download or provider call.
The batch never substitutes complete-service transcription.

The Anthropic adapter now implements request construction and bounded HTTP transport.
Production configuration and real API acceptance remain unfinished.
Representative quality, actual vendor request limits, and billing acceptance remain unfinished.

The handoff passed 20 database cases and 14 selected unit tests.
Cases verified local resolution without escalation, successful visual resolution, continued ambiguity, failures, budget refusal, and invalid evidence.
Successful retries made one visual submission and one Scribe submission.
Final-decision publication preceded Scribe.
Lint, application type checking, the worker build, and whitespace checks passed.
All provider responses were simulated.

See [the Anthropic adapter](P4_ANTHROPIC_VISUAL_ADAPTER.md) for request bounds and context-ceiling evidence.
