import { performance } from "node:perf_hooks";
import type { ProcessingCostFactInput, ProcessingCostStage } from "@/lib/cost/types";

export type PreparationOperation = "analysis_derivatives" | "local_evidence" | "representative_frames" | "sermon_audio" | "transcript_structure" | "proxy_view" | "sparse_ocr" | "boundary_asr" | "boundary_resolution";
export type PreparationMeasure = <T>(operation: PreparationOperation, work: () => Promise<T>) => Promise<T>;
const stages: Record<PreparationOperation, ProcessingCostStage> = {
  boundary_asr: "analysis_classification", boundary_resolution: "analysis_classification", sparse_ocr: "analysis_classification", proxy_view: "render", analysis_derivatives: "render", local_evidence: "analysis_classification", representative_frames: "render",
  sermon_audio: "local_audio_extraction", transcript_structure: "analysis_classification",
};
export const unmeasuredPreparation: PreparationMeasure = (_operation, work) => work();

/** Record complete local stages, including failed work. The recorder must not throw.
 * Wall time includes local validation and subprocess waits. Node CPU is not child CPU.
 * No machine rate is assumed; these facts remain unpriced until resource billing exists.
 */
export function measurePreparation(attempt: number, record: (fact: ProcessingCostFactInput) => Promise<void>): PreparationMeasure {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("PREPARATION_ACCOUNTING_ATTEMPT_INVALID");
  return async (operation, work) => {
    const started = performance.now();
    let outcome: "succeeded" | "failed" = "failed";
    try {
      const result = await work();
      outcome = "succeeded";
      return result;
    } finally {
      const wallTimeMs = Math.max(0, performance.now() - started);
      await record({ stage: stages[operation], quantity: wallTimeMs / 1000, unit: "second", unitCostUsd: null,
        provider: "local_media_worker", model: null, providerProvenance: "preparation_stage_runtime",
        cpuTimeMs: null, wallTimeMs, cacheState: "not_applicable", attempt, outcome,
        details: { operation, cpuMeasurement: "unavailable", pricingBasis: "unavailable" } });
    }
  };
}
