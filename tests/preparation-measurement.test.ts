import { expect, it } from "vitest";
import { measurePreparation } from "@/lib/media/preparation-measurement";
import type { ProcessingCostFactInput } from "@/lib/cost/types";

it("records successful and failed local stages without inventing CPU or prices", async () => {
  const facts: ProcessingCostFactInput[] = [];
  const measure = measurePreparation(2, async fact => { facts.push(fact); });
  const result = { ready: true };
  expect(await measure("analysis_derivatives", async () => result)).toBe(result);
  const error = new Error("decoder failed");
  await expect(measure("sermon_audio", async () => { throw error; })).rejects.toBe(error);
  expect(facts).toEqual([
    expect.objectContaining({ stage: "render", outcome: "succeeded", attempt: 2, cpuTimeMs: null, unitCostUsd: null }),
    expect.objectContaining({ stage: "local_audio_extraction", outcome: "failed", attempt: 2, cpuTimeMs: null, unitCostUsd: null }),
  ]);
  for (const fact of facts) {
    expect(fact.wallTimeMs).toBeGreaterThanOrEqual(0);
    expect(fact.quantity).toBe(fact.wallTimeMs! / 1000);
  }
});

it("records sparse OCR as local classification without claiming child CPU measurements", async () => {
  const facts: ProcessingCostFactInput[] = [];
  await measurePreparation(1, async fact => { facts.push(fact); })("sparse_ocr", async () => "fixture");
  expect(facts).toEqual([expect.objectContaining({ stage: "analysis_classification", cpuTimeMs: null,
    unitCostUsd: null, outcome: "succeeded", details: expect.objectContaining({ operation: "sparse_ocr" }) })]);
});
