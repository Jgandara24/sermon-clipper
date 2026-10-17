import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordProcessingCostFactSafely } from "@/lib/cost/record";
import { finishRuntimeMeasurement, startRuntimeMeasurement } from "@/lib/cost/runtime";
import { transcribeVerifiedSermonAudio } from "./sermon-audio";
import { runSermonSubmissionOnce } from "./submission-ledger";
import { scribePricePerMinuteUsd } from "./scribe-provider";
import { transcriptProvenanceSchema } from "./provenance";
import type { TranscriptionProvider } from "./types";

type VerifiedInput = Parameters<typeof transcribeVerifiedSermonAudio>[0];

/** Consume registered local sermon audio inside its source lease. Stored success skips provider calls and costs. */
export async function transcribeRegisteredSermonAudio(prisma: PrismaClient, input: VerifiedInput & {
  workspaceId: string; artifactId: string; sessionId: string; ownerId: string;
}) {
  const saved = await runSermonSubmissionOnce(prisma, {
    workspaceId: input.workspaceId, sourceVideoId: input.sourceVideoId, artifactId: input.artifactId,
    sessionId: input.sessionId, ownerId: input.ownerId, language: input.language,
  }, async ({ submissionId, artifact }) => {
    const trim = input.audio.evidence;
    if (artifact.sourceSha256 !== input.sourceSha256 || artifact.sha256 !== input.audio.sha256 ||
      artifact.byteCount !== BigInt(input.audio.byteCount) || artifact.startMs !== BigInt(trim.sourceOffsetMs) ||
      artifact.endMs !== BigInt(trim.sourceOffsetMs + trim.durationMs)) throw new Error("SERMON_SUBMISSION_LOCAL_ARTIFACT_MISMATCH");
    const measuredProvider: TranscriptionProvider = {
      name: input.provider.name,
      isAvailable: () => input.provider.isAvailable(),
      transcribe: async params => {
        const started = startRuntimeMeasurement();
        let outcome: "succeeded" | "failed" = "failed";
        try {
          const result = await input.provider.transcribe(params);
          outcome = "succeeded";
          return result;
        } finally {
          const runtime = input.provider.lastTelemetry ?? finishRuntimeMeasurement(started);
          await recordProcessingCostFactSafely(prisma, {
            workspaceId: input.workspaceId, stage: "transcription", quantity: trim.durationMs / 60000, unit: "minute",
            unitCostUsd: scribePricePerMinuteUsd(false), provider: input.provider.name, model: "scribe_v2",
            providerProvenance: "registered_sermon_submission", bytes: input.audio.byteCount,
            wallTimeMs: runtime.wallTimeMs, cpuTimeMs: runtime.cpuTimeMs, cacheState: "miss", attempt: 1, outcome,
            details: { submissionId, sourceVideoId: input.sourceVideoId, artifactId: artifact.id,
              submittedAudioSha256: artifact.sha256, submittedDurationMs: trim.durationMs,
              sourceOffsetMs: trim.sourceOffsetMs, keytermsCount: 0, submittedScope: "sermon_range" },
          });
        }
      },
    };
    const result = await transcribeVerifiedSermonAudio({ ...input, provider: measuredProvider });
    // JSON serialization removes optional undefined speaker fields before canonical persistence.
    return JSON.parse(JSON.stringify(result)) as Prisma.InputJsonObject;
  });
  const envelope = z.object({ provenance: transcriptProvenanceSchema }).passthrough().parse(saved.result);
  if (envelope.provenance.sourceVideoId !== input.sourceVideoId || envelope.provenance.sourceSha256 !== input.sourceSha256 ||
    envelope.provenance.submittedAudioSha256 !== input.audio.sha256 ||
    envelope.provenance.sourceOffsetMs !== input.audio.evidence.sourceOffsetMs ||
    envelope.provenance.submittedDurationMs !== input.audio.evidence.durationMs) throw new Error("SERMON_SUBMISSION_RESULT_IDENTITY_CHANGED");
  return { ...saved, provenance: envelope.provenance };
}
