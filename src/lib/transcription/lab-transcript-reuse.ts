import { labStepEnabled } from "@/lib/lab-flags";
import type { TranscriptionProviderEvidence, TranscriptionResult, TranscriptWord } from "./types";

/**
 * Phase 1 lab only (LAB_TRANSCRIPT_REUSE_ENABLED, docs/PHASE1_LAB_PLAN.md). Every lab round sends
 * the same services to the transcription provider again, about 3,300 ElevenLabs credits a round;
 * on 2026-10-20 failed transcript writes paid for seven more and spent the quota. A lab project may
 * name an earlier lab source of the same video in its processing config; TRANSCRIBE then copies
 * that source's transcript instead of calling the provider. Production never reads the setting.
 */

// Two downloads of one video differ by a fraction of a second in the probed duration.
const MAX_DURATION_DIFFERENCE_S = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LabTranscriptReuseError extends Error {}

export type LabTranscriptReuse = { fromSourceVideoId: string };

/** The source whose transcript a lab project copies; null unless the lab switch is on. */
export function readLabTranscriptReuse(processingConfig: unknown): LabTranscriptReuse | null {
  if (!labStepEnabled("transcriptReuse")) return null;
  if (!processingConfig || typeof processingConfig !== "object" || Array.isArray(processingConfig)) return null;
  const reuse = (processingConfig as { labTranscriptReuse?: { fromSourceVideoId?: unknown } }).labTranscriptReuse;
  const id = reuse?.fromSourceVideoId;
  return typeof id === "string" && UUID.test(id) ? { fromSourceVideoId: id } : null;
}

type Source = { workspaceId: string; originUrl: string | null; durationS: number | null };
type StoredSource = Source & {
  transcript: {
    language: string;
    provider: string;
    providerEvidence: unknown;
    segments: { startMs: number; endMs: number; text: string; speakerLabel: string | null; words: unknown }[];
  } | null;
};

/**
 * The stored transcript as the provider returned it. Refused unless both sources are the same
 * video in the same workspace, with the same duration within a second.
 */
export function reusedTranscription(target: Source, from: StoredSource): { result: TranscriptionResult; provider: string } {
  if (!from.transcript?.segments.length) throw new LabTranscriptReuseError("The source to copy from has no transcript.");
  if (target.workspaceId !== from.workspaceId) throw new LabTranscriptReuseError("The source to copy from is in another workspace.");
  if (!target.originUrl || target.originUrl !== from.originUrl) {
    throw new LabTranscriptReuseError("The source to copy from is not the same video.");
  }
  if (target.durationS === null || from.durationS === null || Math.abs(target.durationS - from.durationS) > MAX_DURATION_DIFFERENCE_S) {
    throw new LabTranscriptReuseError(
      `The two downloads differ in length by more than ${MAX_DURATION_DIFFERENCE_S} second, so the timings would not match.`,
    );
  }
  // Saving adds displayCapabilities to the evidence; the transcribe step adds it again.
  const stored = from.transcript.providerEvidence as (TranscriptionProviderEvidence & { displayCapabilities?: unknown }) | null;
  const providerEvidence = stored ? (({ displayCapabilities: _, ...evidence }) => evidence)(stored) : undefined;
  return {
    provider: from.transcript.provider,
    result: {
      language: from.transcript.language,
      ...(providerEvidence ? { providerEvidence } : {}),
      segments: from.transcript.segments.map((segment) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        words: segment.words as TranscriptWord[],
        ...(segment.speakerLabel ? { speakerLabel: segment.speakerLabel } : {}),
      })),
    },
  };
}

/**
 * The processing config `lab:run --reuse-transcript-from <project>` gives a new lab project: the
 * project's own config plus the earlier project's source to copy from. Refused unless the earlier
 * project is the same video and has a transcript.
 */
export function withLabTranscriptReuse(
  processingConfig: unknown,
  url: string,
  earlier: { projectId: string; sourceVideoId: string | null; originUrl: string | null; hasTranscript: boolean },
): Record<string, unknown> {
  if (!earlier.sourceVideoId || !earlier.hasTranscript) throw new LabTranscriptReuseError("The earlier project has no transcript.");
  if (earlier.originUrl?.trim() !== url.trim()) throw new LabTranscriptReuseError("The earlier project is not the same video.");
  const config = processingConfig && typeof processingConfig === "object" && !Array.isArray(processingConfig) ? processingConfig : {};
  return { ...config, labTranscriptReuse: { fromSourceVideoId: earlier.sourceVideoId, fromProjectId: earlier.projectId } };
}
