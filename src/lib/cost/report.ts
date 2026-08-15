import { z } from "zod";
import type { ProcessingCostStage, ProcessingCostUnit } from "./types";

/** Version 2 adds the recording-completeness block that Gate A now enforces. */
export const COST_TRUTH_SCHEMA_VERSION = 2;
export const TYPICAL_SERVICES_PER_MONTH = 8.66;
export const CORE_COST_PER_SERVICE_CAP_USD = 1.5;
export const DIRECT_UPLOAD_MONTHLY_CHURCH_COST_CAP_USD = 8;
export const YOUTUBE_MONTHLY_CHURCH_COST_CAP_USD = 12;

export type YouTubeProxyEconomicsInput = {
  sourceBytes: number;
  sourceDurationSeconds: number;
  contractedPricePerGbUsd: number;
  coreCostPerServiceUsd: number;
  servicesPerMonth: number;
};

/** Calculates a conservative lower bound from stored source bytes and the real proxy contract. */
export function assessYouTubeProxyEconomics(input: YouTubeProxyEconomicsInput) {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative.`);
  }
  if (input.sourceBytes === 0 || input.sourceDurationSeconds === 0 || input.servicesPerMonth === 0) {
    throw new Error("Source bytes, source duration, and monthly service count must be positive.");
  }
  const proxyCostPerServiceUsd =
    (input.sourceBytes / 1_000_000_000) * input.contractedPricePerGbUsd;
  const proxyCostPerSourceHourUsd =
    proxyCostPerServiceUsd / (input.sourceDurationSeconds / 3_600);
  const projectedMonthlyProxyCostUsd = proxyCostPerServiceUsd * input.servicesPerMonth;
  const projectedMonthlyLowerBoundUsd =
    (proxyCostPerServiceUsd + input.coreCostPerServiceUsd) * input.servicesPerMonth;
  return {
    proxyCostPerServiceUsd,
    proxyCostPerSourceHourUsd,
    projectedMonthlyProxyCostUsd,
    projectedMonthlyLowerBoundUsd,
    approved:
      input.coreCostPerServiceUsd <= CORE_COST_PER_SERVICE_CAP_USD &&
      projectedMonthlyLowerBoundUsd <= YOUTUBE_MONTHLY_CHURCH_COST_CAP_USD,
  };
}

const REQUIRED_STAGES = [
  "source_acquisition",
  "upload",
  "download",
  "local_audio_extraction",
  "transcription",
  "analysis_classification",
  "analysis_scoring",
  "render",
] as const satisfies readonly ProcessingCostStage[];

const stageSchema = z.enum([
  "source_acquisition",
  "upload",
  "download",
  "local_audio_extraction",
  "transcription",
  "analysis_classification",
  "analysis_scoring",
  "storage",
  "render",
]);

const unitSchema = z.enum([
  "call",
  "byte",
  "gigabyte",
  "second",
  "minute",
  "token",
  "image",
  "operation",
  "gigabyte_day",
]);

const nonNegative = z.number().finite().nonnegative();
const optionalMeasurement = nonNegative.nullable();
const hostSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9.-]+$/i, "must contain a host name only");

const chargeSchema = z.object({
  chargeId: z.string().min(1),
  stage: stageSchema,
  provider: z.string().min(1),
  model: z.string().min(1).nullable(),
  providerProvenance: z.string().min(1),
  quantity: nonNegative,
  unit: unitSchema,
  unitCostUsd: optionalMeasurement,
  pricingStatus: z.enum(["priced", "zero_cost", "unpriced"]),
  totalCostUsd: optionalMeasurement,
  bytes: optionalMeasurement,
  cpuTimeMs: optionalMeasurement,
  wallTimeMs: optionalMeasurement,
  attempt: z.number().int().positive(),
  retry: z.boolean(),
  outcome: z.enum(["succeeded", "failed"]),
  details: z.record(z.string(), z.unknown()),
});

const costTruthReportSchema = z.object({
  schemaVersion: z.literal(COST_TRUTH_SCHEMA_VERSION),
  recordedAt: z.iso.datetime(),
  evidenceType: z.literal("real_service"),
  source: z.object({
    artifactId: z.string().min(1),
    durationSeconds: z.number().finite().positive(),
    sourceBytes: z.number().int().positive(),
    proxyBytes: z.number().int().nonnegative(),
    storageBytes: z.number().int().positive(),
    transcriptionSeconds: z.number().finite().positive(),
    renderSeconds: nonNegative,
    outputBytes: z.number().int().positive(),
  }),
  production: z.object({
    intakePath: z.enum(["youtube_proxy", "direct_upload"]),
    intakeProvider: z.string().min(1),
    relayProvider: z.string().min(1),
    relayEgressPricePerGbUsd: nonNegative,
    proxyProvider: z.string().min(1).nullable(),
    proxyEndpointHost: hostSchema.nullable(),
    proxyContractedPricePerGbUsd: nonNegative.nullable(),
    storageProvider: z.string().min(1),
    storageEndpointHost: hostSchema,
    storageEgressPricePerGbUsd: nonNegative,
  }),
  sandboxAnchor: z.object({
    artifactId: z.string().min(1),
    analysisCostUsd: nonNegative,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  projection: z.object({ servicesPerMonth: z.number().finite().positive() }),
  // Cost recording is best effort at run time so telemetry cannot destroy customer work. The
  // evidence gate is where completeness is enforced: any dropped fact makes the report unusable.
  recording: z.object({ costFactRecordFailures: z.number().int().nonnegative() }),
  charges: z.array(chargeSchema).min(1),
  measuredTotals: z.object({
    proxyCostPerSourceHourUsd: nonNegative,
    intakeCostUsd: nonNegative,
    coreCostPerServiceUsd: nonNegative,
    serviceCostUsd: nonNegative,
    projectedMonthlyChurchCostUsd: nonNegative,
    retryCount: z.number().int().nonnegative(),
    gateAPassed: z.boolean(),
  }),
});

export type CostTruthCharge = z.infer<typeof chargeSchema> & {
  stage: ProcessingCostStage;
  unit: ProcessingCostUnit;
};
export type CostTruthReportInput = z.input<typeof costTruthReportSchema>;
export type CostTruthReport = z.output<typeof costTruthReportSchema>;

export type CostTruthSummary = {
  proxyCostPerSourceHourUsd: number;
  intakeCostUsd: number;
  coreCostPerServiceUsd: number;
  serviceCostUsd: number;
  projectedMonthlyChurchCostUsd: number;
  retryCount: number;
  analysisCostUsd: number;
  gateAPassed: boolean;
};

function isIntakeCharge(charge: CostTruthCharge): boolean {
  return charge.stage === "source_acquisition" || charge.provider === "railway_egress";
}

function knownCost(charge: CostTruthCharge): number {
  return charge.totalCostUsd ?? 0;
}

function presentStages(charges: CostTruthCharge[]): Set<ProcessingCostStage> {
  return new Set(charges.map((charge) => charge.stage));
}

function withinAnchorTolerance(measured: number, anchor: number): boolean {
  return anchor === 0 ? measured === 0 : Math.abs(measured - anchor) / anchor <= 0.25;
}

function analysisUsageReconciles(report: CostTruthReport): boolean {
  const analysisCharges = report.charges.filter(
    (charge) =>
      charge.stage === "analysis_classification" || charge.stage === "analysis_scoring",
  );
  const inputTokens = analysisCharges.reduce(
    (sum, charge) => sum + Number(charge.details.inputTokens ?? 0),
    0,
  );
  const outputTokens = analysisCharges.reduce(
    (sum, charge) => sum + Number(charge.details.outputTokens ?? 0),
    0,
  );
  return (
    withinAnchorTolerance(inputTokens, report.sandboxAnchor.inputTokens) &&
    withinAnchorTolerance(outputTokens, report.sandboxAnchor.outputTokens)
  );
}

function monthlyCostCapUsd(report: CostTruthReport): number {
  return report.production.intakePath === "direct_upload"
    ? DIRECT_UPLOAD_MONTHLY_CHURCH_COST_CAP_USD
    : YOUTUBE_MONTHLY_CHURCH_COST_CAP_USD;
}

/** Derives all decision totals from immutable charge rows. Retries remain billable. */
export function summarizeCostTruthReport(input: CostTruthReportInput): CostTruthSummary {
  const report = costTruthReportSchema.parse(input);
  const charges = report.charges as CostTruthCharge[];
  const intakeCostUsd = charges
    .filter(isIntakeCharge)
    .reduce((sum, charge) => sum + knownCost(charge), 0);
  const coreCostPerServiceUsd = charges
    .filter((charge) => !isIntakeCharge(charge))
    .reduce((sum, charge) => sum + knownCost(charge), 0);
  const analysisCostUsd = charges
    .filter(
      (charge) =>
        charge.stage === "analysis_classification" || charge.stage === "analysis_scoring",
    )
    .reduce((sum, charge) => sum + knownCost(charge), 0);
  const serviceCostUsd = intakeCostUsd + coreCostPerServiceUsd;
  const projectedMonthlyChurchCostUsd = serviceCostUsd * report.projection.servicesPerMonth;
  const proxyCostPerSourceHourUsd =
    charges
      .filter(
        (charge) =>
          charge.stage === "source_acquisition" && charge.details.proxyUsed === true,
      )
      .reduce((sum, charge) => sum + knownCost(charge), 0) /
    (report.source.durationSeconds / 3_600);
  const retryCount = charges.filter((charge) => charge.retry || charge.attempt > 1).length;
  const stages = presentStages(charges);
  const gateAPassed =
    REQUIRED_STAGES.every((stage) => stages.has(stage)) &&
    report.recording.costFactRecordFailures === 0 &&
    charges.every((charge) => charge.pricingStatus !== "unpriced") &&
    coreCostPerServiceUsd <= CORE_COST_PER_SERVICE_CAP_USD &&
    projectedMonthlyChurchCostUsd <= monthlyCostCapUsd(report) &&
    analysisUsageReconciles(report);

  return {
    proxyCostPerSourceHourUsd,
    intakeCostUsd,
    coreCostPerServiceUsd,
    serviceCostUsd,
    projectedMonthlyChurchCostUsd,
    retryCount,
    analysisCostUsd,
    gateAPassed,
  };
}

function closeEnough(actual: number, stated: number): boolean {
  return Math.abs(actual - stated) <= 0.000001;
}

function analysisDetailsIssues(charge: CostTruthCharge): string[] {
  if (charge.stage !== "analysis_classification" && charge.stage !== "analysis_scoring") return [];
  const issues: string[] = [];
  if (!charge.model) issues.push(`${charge.chargeId}: analysis model is required.`);
  for (const name of ["inputTokens", "outputTokens", "imageCount"] as const) {
    const value = charge.details[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      issues.push(`${charge.chargeId}: details.${name} must be a non-negative integer.`);
    }
  }
  return issues;
}

export type CostTruthValidationResult =
  | { ok: true; issues: []; report: CostTruthReport; summary: CostTruthSummary }
  | { ok: false; issues: string[] };

/** Validates one public-safe, real-service Gate A artifact and all derived totals. */
export function validateCostTruthReport(input: unknown): CostTruthValidationResult {
  const parsed = costTruthReportSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "report"}: ${issue.message}`,
      ),
    };
  }

  const report = parsed.data;
  const charges = report.charges as CostTruthCharge[];
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const charge of charges) {
    if (ids.has(charge.chargeId)) issues.push(`Duplicate chargeId: ${charge.chargeId}.`);
    ids.add(charge.chargeId);
    if (charge.pricingStatus === "unpriced" || charge.unitCostUsd === null) {
      issues.push(`${charge.chargeId}: unpriced processing unit blocks Gate A.`);
    } else if (charge.totalCostUsd === null) {
      issues.push(`${charge.chargeId}: priced processing unit needs totalCostUsd.`);
    } else if (!closeEnough(charge.quantity * charge.unitCostUsd, charge.totalCostUsd)) {
      issues.push(`${charge.chargeId}: totalCostUsd does not match quantity times unitCostUsd.`);
    }
    if (charge.retry !== (charge.attempt > 1)) {
      issues.push(`${charge.chargeId}: retry must match attempt > 1.`);
    }
    issues.push(...analysisDetailsIssues(charge));
  }

  const stages = presentStages(charges);
  for (const stage of REQUIRED_STAGES) {
    if (!stages.has(stage)) issues.push(`Missing required processing stage: ${stage}.`);
  }
  if (report.recording.costFactRecordFailures > 0) {
    issues.push(
      `${report.recording.costFactRecordFailures} cost fact(s) failed to record; the measured totals are incomplete.`,
    );
  }
  if (!charges.some((charge) => charge.stage === "upload" && charge.provider.endsWith("_storage"))) {
    issues.push("Missing required production storage upload fact.");
  }
  if (!charges.some((charge) => charge.stage === "download" && charge.provider.endsWith("_storage"))) {
    issues.push("Missing required production storage download fact.");
  }
  for (const charge of charges.filter(
    (candidate) =>
      candidate.stage === "local_audio_extraction" ||
      candidate.stage === "transcription" ||
      (candidate.stage === "render" && candidate.unit === "second"),
  )) {
    if (charge.cpuTimeMs === null) issues.push(`${charge.chargeId}: local work needs measured CPU time.`);
  }
  for (const charge of charges.filter((candidate) => candidate.stage === "transcription")) {
    if (!charge.model) issues.push(`${charge.chargeId}: transcription model is required.`);
  }

  const sourceCharges = charges.filter((charge) => charge.stage === "source_acquisition");
  const sourceAcquisitionBytes = sourceCharges.reduce(
    (sum, charge) => sum + (charge.bytes ?? 0),
    0,
  );
  if (sourceAcquisitionBytes < report.source.sourceBytes) {
    issues.push("Measured source-acquisition bytes cannot be smaller than the stored source.");
  }
  const proxyBytes = sourceCharges
    .filter((charge) => charge.details.proxyUsed === true)
    .reduce((sum, charge) => sum + (charge.bytes ?? 0), 0);
  if (proxyBytes !== report.source.proxyBytes) {
    issues.push("source.proxyBytes must equal measured proxied source-acquisition bytes, including retries.");
  }
  if (report.production.intakePath === "youtube_proxy") {
    if (
      report.production.proxyProvider === null ||
      report.production.proxyEndpointHost === null ||
      report.production.proxyContractedPricePerGbUsd === null
    ) {
      issues.push("YouTube proxy reports require the production proxy contract and host.");
    } else {
      if (
        !sourceCharges.some(
          (charge) =>
            charge.provider === "residential_proxy" &&
            charge.details.proxyUsed === true &&
            charge.details.proxyHost === report.production.proxyEndpointHost,
        )
      ) {
        issues.push("The report does not prove a real proxy acquisition from the production proxy host.");
      }
      if (
        sourceCharges.some(
          (charge) => charge.unitCostUsd !== report.production.proxyContractedPricePerGbUsd,
        )
      ) {
        issues.push("Source-acquisition pricing does not match the contracted proxy price.");
      }
    }
  } else {
    if (
      report.production.proxyProvider !== null ||
      report.production.proxyEndpointHost !== null ||
      report.production.proxyContractedPricePerGbUsd !== null ||
      report.source.proxyBytes !== 0
    ) {
      issues.push("Direct-upload reports must not claim proxy use or a proxy contract.");
    }
    if (
      !sourceCharges.some(
        (charge) =>
          charge.provider === "browser_direct" && charge.details.proxyUsed === false,
      )
    ) {
      issues.push("The report does not prove a measured direct browser upload.");
    }
    if (sourceCharges.some((charge) => charge.unitCostUsd !== 0)) {
      issues.push("Direct browser acquisition must have zero source-provider cost.");
    }
  }
  const relayCharges = charges.filter((charge) => charge.provider === "railway_egress");
  if (relayCharges.length === 0) {
    issues.push("Missing required production relay-egress fact.");
  } else if (
    relayCharges.some(
      (charge) => charge.unitCostUsd !== report.production.relayEgressPricePerGbUsd,
    )
  ) {
    issues.push("Relay-egress pricing does not match the production contracted price.");
  }
  const storageDownloads = charges.filter(
    (charge) => charge.stage === "download" && charge.provider.endsWith("_storage"),
  );
  if (
    storageDownloads.some(
      (charge) => charge.unitCostUsd !== report.production.storageEgressPricePerGbUsd,
    )
  ) {
    issues.push("Storage-download pricing does not match the contracted storage egress price.");
  }
  const transcriptionSeconds = charges
    .filter((charge) => charge.stage === "transcription")
    .reduce(
      (sum, charge) =>
        sum + (charge.unit === "minute" ? charge.quantity * 60 : charge.unit === "second" ? charge.quantity : 0),
      0,
    );
  if (!closeEnough(transcriptionSeconds, report.source.transcriptionSeconds)) {
    issues.push("source.transcriptionSeconds does not match the measured transcription charges.");
  }
  const renderSeconds = charges
    .filter((charge) => charge.stage === "render" && charge.unit === "second")
    .reduce((sum, charge) => sum + charge.quantity, 0);
  if (!closeEnough(renderSeconds, report.source.renderSeconds)) {
    issues.push("source.renderSeconds does not match the measured render charges.");
  }

  const analysisCharges = charges.filter(
    (charge) =>
      charge.stage === "analysis_classification" || charge.stage === "analysis_scoring",
  );
  const inputTokens = analysisCharges.reduce(
    (sum, charge) => sum + Number(charge.details.inputTokens ?? 0),
    0,
  );
  const outputTokens = analysisCharges.reduce(
    (sum, charge) => sum + Number(charge.details.outputTokens ?? 0),
    0,
  );
  for (const [name, measured, anchor] of [
    ["input tokens", inputTokens, report.sandboxAnchor.inputTokens],
    ["output tokens", outputTokens, report.sandboxAnchor.outputTokens],
  ] as const) {
    if (!withinAnchorTolerance(measured, anchor)) {
      issues.push(`Analysis ${name} do not reconcile within 25% of the production sandbox anchor.`);
    }
  }

  const summary = summarizeCostTruthReport(report);
  for (const name of [
    "proxyCostPerSourceHourUsd",
    "intakeCostUsd",
    "coreCostPerServiceUsd",
    "serviceCostUsd",
    "projectedMonthlyChurchCostUsd",
  ] as const) {
    if (!closeEnough(summary[name], report.measuredTotals[name])) {
      issues.push(`measuredTotals.${name} does not match the charge-derived value.`);
    }
  }
  if (summary.retryCount !== report.measuredTotals.retryCount) {
    issues.push("measuredTotals.retryCount does not match the charge-derived value.");
  }
  if (summary.gateAPassed !== report.measuredTotals.gateAPassed) {
    issues.push("measuredTotals.gateAPassed does not match the enforced gates.");
  }
  if (summary.coreCostPerServiceUsd > CORE_COST_PER_SERVICE_CAP_USD) {
    issues.push(`Core cost exceeds $${CORE_COST_PER_SERVICE_CAP_USD.toFixed(2)} per service.`);
  }
  const appliedMonthlyCapUsd = monthlyCostCapUsd(report);
  if (summary.projectedMonthlyChurchCostUsd > appliedMonthlyCapUsd) {
    issues.push(
      `Projected monthly church cost exceeds the $${appliedMonthlyCapUsd.toFixed(2)} ${report.production.intakePath} gate.`,
    );
  }
  if (!summary.gateAPassed) issues.push("Gate A did not pass.");

  return issues.length === 0 ? { ok: true, issues: [], report, summary } : { ok: false, issues };
}
