import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessYouTubeProxyEconomics,
  summarizeCostTruthReport,
  validateCostTruthReport,
  type CostTruthReportInput,
} from "@/lib/cost/report";

const baseCharges: CostTruthReportInput["charges"] = [
  {
    chargeId: "source-acquisition-1",
    stage: "source_acquisition",
    provider: "residential_proxy",
    model: null,
    providerProvenance: "yt_dlp_runtime",
    quantity: 0.2,
    unit: "gigabyte",
    unitCostUsd: 2,
    pricingStatus: "priced",
    totalCostUsd: 0.4,
    bytes: 200_000_000,
    cpuTimeMs: null,
    wallTimeMs: 60_000,
    attempt: 1,
    retry: false,
    outcome: "succeeded",
    details: { proxyUsed: true, proxyHost: "geo.example", sourceDurationS: 3_000 },
  },
  {
    chargeId: "railway-egress-1",
    stage: "upload",
    provider: "railway_egress",
    model: null,
    providerProvenance: "yt_dlp_runtime",
    quantity: 0.2,
    unit: "gigabyte",
    unitCostUsd: 0.05,
    pricingStatus: "priced",
    totalCostUsd: 0.01,
    bytes: 200_000_000,
    cpuTimeMs: null,
    wallTimeMs: 10_000,
    attempt: 1,
    retry: false,
    outcome: "succeeded",
    details: {},
  },
  {
    chargeId: "storage-download-1",
    stage: "download",
    provider: "s3_storage",
    model: null,
    providerProvenance: "storage_provider_config",
    quantity: 0.3,
    unit: "gigabyte",
    unitCostUsd: 0,
    pricingStatus: "zero_cost",
    totalCostUsd: 0,
    bytes: 300_000_000,
    cpuTimeMs: null,
    wallTimeMs: 20_000,
    attempt: 1,
    retry: false,
    outcome: "succeeded",
    details: {},
  },
  {
    chargeId: "storage-upload-1",
    stage: "upload",
    provider: "s3_storage",
    model: null,
    providerProvenance: "storage_provider_config",
    quantity: 0.115,
    unit: "gigabyte",
    unitCostUsd: 0,
    pricingStatus: "zero_cost",
    totalCostUsd: 0,
    bytes: 115_000_000,
    cpuTimeMs: null,
    wallTimeMs: 8_000,
    attempt: 1,
    retry: false,
    outcome: "succeeded",
    details: {},
  },
  {
    chargeId: "audio-1",
    stage: "local_audio_extraction",
    provider: "ffmpeg_audio",
    model: null,
    providerProvenance: "local_worker_runtime",
    quantity: 3_000,
    unit: "second",
    unitCostUsd: 0,
    pricingStatus: "zero_cost",
    totalCostUsd: 0,
    bytes: null,
    cpuTimeMs: 8_000,
    wallTimeMs: 12_000,
    attempt: 1,
    retry: false,
    outcome: "succeeded",
    details: {},
  },
  {
    chargeId: "transcription-1",
    stage: "transcription",
    provider: "whisper_cpp",
    model: "ggml-small.en.bin",
    providerProvenance: "runtime_provider_selection",
    quantity: 50,
    unit: "minute",
    unitCostUsd: 0,
    pricingStatus: "zero_cost",
    totalCostUsd: 0,
    bytes: null,
    cpuTimeMs: 20_000,
    wallTimeMs: 40_000,
    attempt: 1,
    retry: false,
    outcome: "succeeded",
    details: {},
  },
  {
    chargeId: "classification-1",
    stage: "analysis_classification",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    providerProvenance: "production_default",
    quantity: 1,
    unit: "call",
    unitCostUsd: 0.08,
    pricingStatus: "priced",
    totalCostUsd: 0.08,
    bytes: null,
    cpuTimeMs: null,
    wallTimeMs: 20_000,
    attempt: 1,
    retry: false,
    outcome: "succeeded",
    details: { inputTokens: 67_769, outputTokens: 7_187, imageCount: 0 },
  },
  {
    chargeId: "scoring-1",
    stage: "analysis_scoring",
    provider: "anthropic",
    model: "claude-sonnet-5",
    providerProvenance: "production_default",
    quantity: 1,
    unit: "call",
    unitCostUsd: 0.076798,
    pricingStatus: "priced",
    totalCostUsd: 0.076798,
    bytes: null,
    cpuTimeMs: null,
    wallTimeMs: 25_000,
    attempt: 1,
    retry: false,
    outcome: "succeeded",
    details: { inputTokens: 6_893, outputTokens: 2_161, imageCount: 0 },
  },
  {
    chargeId: "render-1",
    stage: "render",
    provider: "ffmpeg",
    model: null,
    providerProvenance: "local_worker_runtime",
    quantity: 60,
    unit: "second",
    unitCostUsd: 0,
    pricingStatus: "zero_cost",
    totalCostUsd: 0,
    bytes: 12_000_000,
    cpuTimeMs: 5_000,
    wallTimeMs: 8_000,
    attempt: 1,
    retry: false,
    outcome: "succeeded",
    details: {},
  },
];

function completeReport(): CostTruthReportInput {
  return {
    schemaVersion: 2,
    recordedAt: "2026-08-12T12:00:00.000Z",
    evidenceType: "real_service",
    source: {
      artifactId: "gate-a-service-2026-08-12",
      durationSeconds: 3_000,
      sourceBytes: 200_000_000,
      proxyBytes: 200_000_000,
      storageBytes: 315_000_000,
      transcriptionSeconds: 3_000,
      renderSeconds: 60,
      outputBytes: 12_000_000,
    },
    production: {
      intakePath: "youtube_proxy",
      intakeProvider: "residential_proxy",
      relayProvider: "Railway",
      relayEgressPricePerGbUsd: 0.05,
      proxyProvider: "IPRoyal",
      proxyEndpointHost: "geo.example",
      proxyContractedPricePerGbUsd: 2,
      storageProvider: "Cloudflare R2",
      storageEndpointHost: "account.r2.cloudflarestorage.com",
      storageEgressPricePerGbUsd: 0,
    },
    sandboxAnchor: {
      artifactId: "clip-count-retest-8-11",
      analysisCostUsd: 0.156798,
      inputTokens: 74_662,
      outputTokens: 9_348,
    },
    projection: { servicesPerMonth: 8.66 },
    recording: { costFactRecordFailures: 0 },
    charges: structuredClone(baseCharges),
    measuredTotals: {
      proxyCostPerSourceHourUsd: 0.48,
      intakeCostUsd: 0.41,
      coreCostPerServiceUsd: 0.156798,
      serviceCostUsd: 0.566798,
      projectedMonthlyChurchCostUsd: 4.908471,
      retryCount: 0,
      gateAPassed: true,
    },
  };
}

function directUploadReport(): CostTruthReportInput {
  const report = completeReport();
  report.source.proxyBytes = 0;
  report.charges[0] = {
    ...report.charges[0],
    provider: "browser_direct",
    unitCostUsd: 0,
    pricingStatus: "zero_cost",
    totalCostUsd: 0,
    details: { proxyUsed: false, uploadId: "upload-1" },
  };
  report.production = {
    intakePath: "direct_upload",
    intakeProvider: "browser_direct",
    relayProvider: "Railway",
    relayEgressPricePerGbUsd: 0.05,
    proxyProvider: null,
    proxyEndpointHost: null,
    proxyContractedPricePerGbUsd: null,
    storageProvider: "Cloudflare R2",
    storageEndpointHost: "account.r2.cloudflarestorage.com",
    storageEgressPricePerGbUsd: 0,
  };
  report.measuredTotals = summarizeCostTruthReport(report);
  return report;
}

describe("P0 cost-truth report", () => {
  it("fails the YouTube gate for the measured source at the current proxy contract", () => {
    const result = assessYouTubeProxyEconomics({
      sourceBytes: 392_808_104,
      sourceDurationSeconds: 2_981.76,
      contractedPricePerGbUsd: 6.25,
      coreCostPerServiceUsd: 0.156798,
      servicesPerMonth: 8.66,
    });

    expect(result).toMatchObject({
      proxyCostPerServiceUsd: 2.45505065,
      proxyCostPerSourceHourUsd: 2.964082400998068,
      projectedMonthlyProxyCostUsd: 21.260738629,
      projectedMonthlyLowerBoundUsd: 22.618609309,
      approved: false,
    });
  });

  it("keeps the committed proxy hard-stop baseline derived from its measured inputs", () => {
    const path = resolve("evaluation/proxy-cost-baseline-2026-08-13.json");
    const baseline = JSON.parse(readFileSync(path, "utf8")) as {
      measured: Parameters<typeof assessYouTubeProxyEconomics>[0];
      result: ReturnType<typeof assessYouTubeProxyEconomics>;
    };

    expect(baseline.result).toEqual(assessYouTubeProxyEconomics(baseline.measured));
    expect(baseline.result.approved).toBe(false);
  });

  it("rejects a missing required stage", () => {
    const report = completeReport();
    report.charges = report.charges.filter((charge) => charge.stage !== "transcription");

    expect(validateCostTruthReport(report)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.stringContaining("transcription")]),
    });
  });

  it("rejects a report whose window dropped a cost fact", () => {
    // Run-time recording is best effort so telemetry cannot destroy customer work. Completeness
    // is enforced here instead: a dropped fact means the measured totals undercount.
    const report = completeReport();
    report.recording = { costFactRecordFailures: 1 };

    const result = validateCostTruthReport(report);
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.stringContaining("failed to record")]),
    });
    expect(summarizeCostTruthReport(report).gateAPassed).toBe(false);
  });

  it("rejects an unpriced paid unit", () => {
    const report = completeReport();
    report.charges[0] = {
      ...report.charges[0],
      unitCostUsd: null,
      totalCostUsd: null,
      pricingStatus: "unpriced",
    };

    expect(validateCostTruthReport(report)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.stringContaining("unpriced")]),
    });
  });

  it("rejects a duplicate charge", () => {
    const report = completeReport();
    report.charges.push({ ...report.charges[0] });

    expect(validateCostTruthReport(report)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.stringContaining("Duplicate chargeId")]),
    });
  });

  it("includes a retry in cost and retry totals", () => {
    const report = completeReport();
    report.charges.push({
      ...report.charges[0],
      chargeId: "source-acquisition-retry",
      attempt: 2,
      retry: true,
      totalCostUsd: 0.4,
    });

    const summary = summarizeCostTruthReport(report);
    expect(summary.retryCount).toBe(1);
    expect(summary.intakeCostUsd).toBeCloseTo(0.81, 9);
    expect(summary.serviceCostUsd).toBeCloseTo(0.966798, 9);
  });

  it("accepts a complete measured report", () => {
    expect(validateCostTruthReport(completeReport())).toMatchObject({ ok: true, issues: [] });
  });

  it("uses token volume, not changed model pricing, to reconcile the sandbox anchor", () => {
    const report = completeReport();
    report.charges[6] = {
      ...report.charges[6],
      unitCostUsd: 0.121197,
      totalCostUsd: 0.121197,
    };
    report.charges[7] = {
      ...report.charges[7],
      unitCostUsd: 0.079926,
      totalCostUsd: 0.079926,
    };
    report.measuredTotals = summarizeCostTruthReport(report);

    expect(report.measuredTotals.coreCostPerServiceUsd).toBeCloseTo(0.201123, 9);
    expect(validateCostTruthReport(report)).toMatchObject({ ok: true, issues: [] });
  });

  it("rejects analysis token volume outside the sandbox-anchor tolerance", () => {
    const report = completeReport();
    report.charges[6] = {
      ...report.charges[6],
      details: { ...report.charges[6].details, inputTokens: 120_000 },
    };
    report.measuredTotals = summarizeCostTruthReport(report);

    expect(validateCostTruthReport(report)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.stringContaining("input tokens")]),
    });
  });

  it("projects one measured service to a typical church month", () => {
    const summary = summarizeCostTruthReport(completeReport());
    expect(summary.projectedMonthlyChurchCostUsd).toBeCloseTo(0.566798 * 8.66, 6);
    expect(summary.gateAPassed).toBe(true);
  });

  it("accepts a complete direct-upload report under the $8 monthly gate", () => {
    expect(validateCostTruthReport(directUploadReport())).toMatchObject({ ok: true, issues: [] });
  });

  it("enforces the $8 direct-upload monthly gate", () => {
    const report = directUploadReport();
    report.charges[1] = {
      ...report.charges[1],
      unitCostUsd: 4,
      pricingStatus: "priced",
      totalCostUsd: 0.8,
    };
    report.production.relayEgressPricePerGbUsd = 4;
    report.measuredTotals = summarizeCostTruthReport(report);

    expect(report.measuredTotals.projectedMonthlyChurchCostUsd).toBeGreaterThan(8);
    expect(report.measuredTotals.projectedMonthlyChurchCostUsd).toBeLessThan(12);
    expect(validateCostTruthReport(report)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.stringContaining("$8.00 direct_upload gate")]),
    });
  });
});
