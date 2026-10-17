# Slide boundary policy

`applySlideBoundaryPolicy` proposes one continuous source interval.
The caller supplies source identity, region facts, required speech intervals, safe cut points, and explicit trim settings.
The policy does not choose thresholds or infer which speech the clip requires.
It keeps detector facts separate from editorial rules.

All full-screen slide subtypes use the same edge rules.
The policy merges overlapping or adjacent slide intervals.
It trims an edge slide only at a supplied safe cut beyond the configured clearance.
Each edge must stay within the configured trim limit.
The remaining interval must meet the configured minimum duration.
The policy rejects slides inside the original candidate, including slides that a larger trim could skip.
It rejects any trim that removes required speech.

Worship, announcements, prayer, baptism, altar calls, other service content, and verse slideshows cause rejection.
Ambiguous regions also cause rejection.
Low detector confidence does not weaken these rules.
Intervals use half-open overlap, so touching endpoints do not overlap.
The policy rejects conflicting source identities, duplicate facts, and invalid cut-point sequences.

The result records its policy version, input checksum, settings, source identity, original interval, and fact identities.
Fact order does not change the input checksum.
Results are `UNCHANGED`, `TRIMMED`, or `REJECT`.
Every result states `semanticApproval: not_evaluated`.
A successful boundary check does not prove detector coverage or message completeness.

The production candidate pipeline does not invoke this policy yet.
Integration requires precise regions, trustworthy safe cuts, required-speech evidence, and renewed complete-message validation after trimming.
The export pipeline must also verify the final interval against current forbidden regions.

All 23 policy tests passed.
Tests covered every slide subtype, forbidden service types, edge limits, required speech, middle slides, and source identity.
Lint, type checking, and the worker build passed.
These tests prove deterministic policy behavior, not detector accuracy or production enforcement.
