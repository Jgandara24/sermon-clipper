import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockMediaSource } from "@/lib/media-artifacts/persistence";
import { sha256Schema } from "@/lib/media-artifacts/types";
import { recordProcessingCostFactSafely } from "@/lib/cost/record";
import { rangeEvidenceSha256 } from "./range-evidence";

const integer = z.number().int().nonnegative().safe();
export const visualEscalationBudgetSchema = z.object({ maxInputTokens: integer.positive(), maxOutputTokens: integer.positive(),
  inputMicroUsdPerMillionTokens: integer, outputMicroUsdPerMillionTokens: integer,
  budgetMicroUsd: integer.positive(), priceEvidenceReference: z.string().trim().min(1) }).strict();
export function visualEscalationCostMicroUsd(inputTokens: number, outputTokens: number,
  prices: Pick<z.infer<typeof visualEscalationBudgetSchema>, "inputMicroUsdPerMillionTokens" | "outputMicroUsdPerMillionTokens">) {
  const values = [inputTokens, outputTokens, prices.inputMicroUsdPerMillionTokens, prices.outputMicroUsdPerMillionTokens].map(value => integer.parse(value));
  return (BigInt(values[0]) * BigInt(values[2]) + BigInt(values[1]) * BigInt(values[3]) + BigInt(999999)) / BigInt(1000000);
}
const requestSchema = z.object({ workspaceId: z.string().uuid(), sourceVideoId: z.string().uuid(),
  sessionId: z.string().uuid(), ownerId: z.string().uuid(), boundaryDecisionArtifactId: z.string().uuid(),
  imageArtifactIds: z.array(z.string().uuid()).min(1).max(8), maxImageBytes: integer.positive(),
  preparedRequestSha256: sha256Schema, provider: z.string().trim().min(1), model: z.string().trim().min(1),
  policyVersion: z.string().trim().min(1), budget: visualEscalationBudgetSchema,
  inputTokenBoundEvidence: z.object({ method: z.literal("model_context_ceiling"), model: z.string().min(1),
    maxInputTokens: integer.positive(), evidenceReference: z.string().trim().min(1) }).strict().optional(),
  maxResponseBytes: integer.positive().max(2147483647) }).strict();
export type VisualEscalationRequest = z.infer<typeof requestSchema>;
const preparedSchema = requestSchema.omit({ workspaceId: true, sourceVideoId: true, sessionId: true, ownerId: true, boundaryDecisionArtifactId: true });
export function visualEscalationPreparedIdentity(input: z.infer<typeof preparedSchema>) {
  return rangeEvidenceSha256(preparedSchema.strip().parse(input));
}
const responseSchema = z.object({ providerRequestId: z.string().min(1).nullable(),
  usage: z.object({ inputTokens: integer, outputTokens: integer }).strict(), response: z.record(z.string(), z.unknown()) }).strict();
export type VisualEscalationResponse = { providerRequestId: string | null; usage: { inputTokens: number; outputTokens: number };
  response: Prisma.InputJsonObject };

/** One durable reservation per source. The adapter must enforce the prepared token limits and disable SDK retries.
 * This service does not choose a model, construct a vendor request, or authorize production activation.
 */
export async function runVisualBoundaryEscalationOnce(prisma: PrismaClient, input: VisualEscalationRequest,
  submit: (admission: { escalationId: string; preparedRequestSha256: string; preparedConfigurationSha256: string; maxInputTokens: number; maxOutputTokens: number }) => Promise<VisualEscalationResponse>) {
  const request = requestSchema.parse(input);
  if (new Set(request.imageArtifactIds).size !== request.imageArtifactIds.length) throw new Error("VISUAL_ESCALATION_DUPLICATE_IMAGE");
  if (request.inputTokenBoundEvidence && (request.inputTokenBoundEvidence.model !== request.model ||
    request.inputTokenBoundEvidence.maxInputTokens > request.budget.maxInputTokens)) throw new Error("VISUAL_ESCALATION_CONTEXT_BOUND_INVALID");
  const reservedCost = visualEscalationCostMicroUsd(request.budget.maxInputTokens, request.budget.maxOutputTokens, request.budget);
  if (reservedCost > BigInt(request.budget.budgetMicroUsd)) throw new Error("VISUAL_ESCALATION_BUDGET_EXCEEDED");
  const admission = await prisma.$transaction(async tx => {
    await lockMediaSource(tx, request.workspaceId, request.sourceVideoId);
    const sessions = await tx.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM source_media_sessions s JOIN source_media_gates g ON g.source_id=s.source_id AND g.generation=s.generation
      WHERE s.id=${request.sessionId}::uuid AND s.source_id=${request.sourceVideoId}::uuid
      AND s.owner_id=${request.ownerId}::uuid AND s.state='ACTIVE' AND s.purpose='P4_DERIVATIVE_BUILD' AND g.state='ACTIVE'
      FOR UPDATE OF s`;
    if (sessions.length !== 1) throw new Error("VISUAL_ESCALATION_OWNER_REQUIRED");
    const artifacts = await tx.derivedMediaArtifact.findMany({ where: { id: { in: [request.boundaryDecisionArtifactId, ...request.imageArtifactIds] } } });
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const decision = artifacts.find(artifact => artifact.id === request.boundaryDecisionArtifactId);
    if (!decision || decision.kind !== "LOCAL_EVIDENCE" || decision.derivationVersion !== "registered-boundary-resolution-v1" ||
      !z.object({ derivation: z.object({ boundaryStatus: z.literal("AMBIGUOUS") }) }).safeParse(decision.publicationEvidence).success) {
      throw new Error("VISUAL_ESCALATION_AMBIGUITY_REQUIRED");
    }
    if (artifacts.length !== request.imageArtifactIds.length + 1 || artifacts.some(artifact =>
      artifact.sourceVideoId !== request.sourceVideoId || artifact.sourceSha256 !== decision.sourceSha256 ||
      artifact.publicationState !== "READY" || artifact.deletedAt || (artifact.expiresAt && artifact.expiresAt <= now))) {
      throw new Error("VISUAL_ESCALATION_ARTIFACT_INVALID");
    }
    const images = request.imageArtifactIds.map(id => artifacts.find(artifact => artifact.id === id)!);
    if (images.some(artifact => !["SPARSE_FRAME", "TIMELINE_VIEW", "BOUNDARY_STRIP"].includes(artifact.kind)) ||
      images.reduce((sum, artifact) => sum + artifact.byteCount, BigInt(0)) > BigInt(request.maxImageBytes)) {
      throw new Error("VISUAL_ESCALATION_IMAGE_LIMIT");
    }
    const stableRequest = requestSchema.omit({ sessionId: true, ownerId: true }).strip().parse(request);
    const evidence = { version: "visual-boundary-reservation-v1", ...stableRequest, sourceSha256: decision.sourceSha256,
      artifacts: [decision, ...images].map(artifact => ({ id: artifact.id, sha256: artifact.sha256,
        byteCount: artifact.byteCount.toString(), kind: artifact.kind, startMs: artifact.startMs.toString(), endMs: artifact.endMs.toString() })),
      reservedCostMicroUsd: reservedCost.toString() };
    const requestIdentity = rangeEvidenceSha256(evidence);
    const existing = await tx.visualBoundaryEscalation.findUnique({ where: { sourceVideoId: request.sourceVideoId } });
    if (existing) {
      if (existing.requestIdentity !== requestIdentity) throw new Error("VISUAL_ESCALATION_ALREADY_USED");
      return { row: existing, created: false };
    }
    return { row: await tx.visualBoundaryEscalation.create({ data: { sourceVideoId: request.sourceVideoId,
      boundaryDecisionArtifactId: decision.id, requestIdentity, requestEvidence: evidence,
      reservedCostMicroUsd: reservedCost, budgetMicroUsd: BigInt(request.budget.budgetMicroUsd) } }), created: true };
  });
  const unwrap = (row: typeof admission.row, reused: boolean) => {
    if (row.state !== "COMPLETED") throw new Error("VISUAL_ESCALATION_UNCERTAIN");
    if (!row.result || rangeEvidenceSha256(row.result) !== row.resultSha256) throw new Error("VISUAL_ESCALATION_RESULT_CHANGED");
    const saved = z.object({ limitsExceeded: z.boolean() }).passthrough().parse(row.result);
    if (saved.limitsExceeded) throw new Error("VISUAL_ESCALATION_RESPONSE_EXCEEDED_LIMITS");
    return { escalationId: row.id, reused, result: row.result };
  };
  if (!admission.created) return unwrap(admission.row, true);
  const started = performance.now();
  let saved: typeof admission.row;
  try {
    const response = responseSchema.parse(await submit({ escalationId: admission.row.id, preparedRequestSha256: request.preparedRequestSha256,
      preparedConfigurationSha256: visualEscalationPreparedIdentity(request), maxInputTokens: request.budget.maxInputTokens, maxOutputTokens: request.budget.maxOutputTokens }));
    const actualCost = visualEscalationCostMicroUsd(response.usage.inputTokens, response.usage.outputTokens, request.budget);
    const result = JSON.parse(JSON.stringify({ ...response, reportedCostMicroUsd: actualCost.toString(), providerBillingVerified: false,
      limitsExceeded: response.usage.inputTokens > request.budget.maxInputTokens || response.usage.outputTokens > request.budget.maxOutputTokens || actualCost > reservedCost })) as Prisma.InputJsonObject;
    if (Buffer.byteLength(JSON.stringify(result)) > request.maxResponseBytes) throw new Error("VISUAL_ESCALATION_RESPONSE_BYTE_LIMIT");
    saved = await prisma.visualBoundaryEscalation.update({ where: { id: admission.row.id }, data: { state: "COMPLETED",
      result, resultSha256: rangeEvidenceSha256(result), finishedAt: new Date() } });
    await recordProcessingCostFactSafely(prisma, { workspaceId: request.workspaceId, stage: "analysis_classification",
      quantity: 1, unit: "call", unitCostUsd: actualCost <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(actualCost) / 1000000 : null,
      provider: request.provider, model: request.model, providerProvenance: "bounded_visual_boundary_escalation",
      wallTimeMs: performance.now() - started, cpuTimeMs: null, attempt: 1,
      outcome: result.limitsExceeded ? "failed" : "succeeded", details: { sourceVideoId: request.sourceVideoId,
        escalationId: saved.id, priceEvidenceReference: request.budget.priceEvidenceReference, providerBillingVerified: false } });
  } catch (error) {
    const changed = await prisma.visualBoundaryEscalation.updateMany({ where: { id: admission.row.id, state: "STARTED" },
      data: { state: "UNCERTAIN", finishedAt: new Date() } });
    if (changed.count) await recordProcessingCostFactSafely(prisma, { workspaceId: request.workspaceId, stage: "analysis_classification",
      quantity: 1, unit: "call", unitCostUsd: null, provider: request.provider, model: request.model,
      providerProvenance: "bounded_visual_boundary_escalation", wallTimeMs: performance.now() - started,
      cpuTimeMs: null, outcome: "failed", attempt: 1, details: { sourceVideoId: request.sourceVideoId,
        escalationId: admission.row.id, outcomeUncertain: true, providerBillingVerified: false } });
    throw error;
  }
  return unwrap(saved, false);
}
