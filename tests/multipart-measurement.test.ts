import { expect, it } from "vitest";
import { multipartMeasurementWorkspace, multipartRequestCostFact, parseMultipartRequestPricing, type MultipartRequestMeasurement } from "@/lib/storage/multipart-measurement";
import { buildProcessingCostFact } from "@/lib/cost/types";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const measurement: MultipartRequestMeasurement = { sessionId, storageKey: `src/${workspaceId}/multipart-${sessionId}`,
  requestId: "measurement-id", operation: "ListParts", wallTimeMs: 12, outcome: "succeeded", httpStatus: 200 };
it("attributes only canonical upload keys to their workspace", () => {
  expect(multipartMeasurementWorkspace(measurement)).toBe(workspaceId);
  for (const storageKey of ["tmp/a", `src/${workspaceId}/multipart-${workspaceId}`, `src/not-a-workspace/multipart-${sessionId}`]) {
    expect(multipartMeasurementWorkspace({ ...measurement, storageKey })).toBeNull();
  }
});
it("keeps request prices unknown and excludes browser transfer bytes", () => {
  const fact = buildProcessingCostFact(multipartRequestCostFact(measurement));
  expect(fact).toMatchObject({ stage: "storage", quantity: 1, unit: "operation", bytes: null,
    totalCostUsd: null, pricingStatus: "unpriced", cpuTimeMs: null, wallTimeMs: 12,
    details: { browserBytesIncluded: false, providerBillingVerified: false, operation: "ListParts" } });
  expect(JSON.stringify(fact)).not.toContain("railway_egress");
  expect(JSON.stringify(fact)).not.toContain(measurement.storageKey);
});


it("applies only the configured operation price and retains evidence identity", () => {
  const pricing = parseMultipartRequestPricing(JSON.stringify({ evidenceId: "fixture-price-v1",
    pricesPerRequestUsd: { ListParts: 0.0000045, AbortMultipartUpload: 0 } }));
  expect(buildProcessingCostFact(multipartRequestCostFact(measurement, pricing))).toMatchObject({
    pricingStatus: "priced", totalCostUsd: 0.0000045, details: { pricingEvidenceId: "fixture-price-v1", requestPriceConfigured: true } });
  expect(buildProcessingCostFact(multipartRequestCostFact({ ...measurement, operation: "AbortMultipartUpload" }, pricing)))
    .toMatchObject({ pricingStatus: "zero_cost", totalCostUsd: 0 });
  expect(buildProcessingCostFact(multipartRequestCostFact({ ...measurement, operation: "HeadObject" }, pricing)))
    .toMatchObject({ pricingStatus: "unpriced", totalCostUsd: null });
});
it.each([
  "not-json", "null", "{}",
  JSON.stringify({ evidenceId: "fixture", pricesPerRequestUsd: { ListParts: -1 } }),
  JSON.stringify({ evidenceId: "fixture", pricesPerRequestUsd: { ListParts: "0" } }),
  JSON.stringify({ evidenceId: "fixture", pricesPerRequestUsd: { UploadPart: 1 } }),
  JSON.stringify({ evidenceId: "https://private.example/secret", pricesPerRequestUsd: {} }),
])("refuses invalid prices without including configuration contents %#", raw => {
  expect(() => parseMultipartRequestPricing(raw)).toThrow("MULTIPART_REQUEST_PRICING_INVALID");
});
it("keeps an absent configuration unpriced", () => {
  expect(parseMultipartRequestPricing()).toEqual({ evidenceId: null, pricesPerRequestUsd: {} });
  expect(parseMultipartRequestPricing("")).toEqual({ evidenceId: null, pricesPerRequestUsd: {} });
});
