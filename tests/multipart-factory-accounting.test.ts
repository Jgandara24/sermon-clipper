import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const record = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cost/record", () => ({ recordProcessingCostFactSafely: record }));
import { closeStorageProvider, getStorageProvider } from "@/lib/storage";

// Keep mutable test configuration separate from the read-only application environment.
const fixtureEnv = vi.hoisted(() => ({ STORAGE_PROVIDER: "s3", STORAGE_S3_BUCKET: "fixture",
  STORAGE_S3_REGION: "auto", STORAGE_S3_ENDPOINT: "https://storage.example.test",
  STORAGE_S3_ACCESS_KEY_ID: "fixture", STORAGE_S3_SECRET_ACCESS_KEY: "fixture", STORAGE_CACHE_MAX_BYTES: 0,
  STORAGE_MULTIPART_REQUEST_PRICING_JSON: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ env: fixtureEnv }));
beforeEach(() => { record.mockClear(); fixtureEnv.STORAGE_MULTIPART_REQUEST_PRICING_JSON = undefined; });
afterEach(async () => { await closeStorageProvider(); vi.restoreAllMocks(); });
it("records the shared factory's multipart request against its durable workspace key", async () => {
  const send = vi.spyOn(S3Client.prototype, "send");
  send.mockImplementation(async () => ({ UploadId: "provider-fixture", $metadata: { httpStatusCode: 200 } }));
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const storage = getStorageProvider();
  expect(await storage.multipart!.create({ key: `src/${workspaceId}/multipart-${sessionId}`, sessionId,
    partBytes: 5242880, totalBytes: 3 })).toEqual({ uploadId: "provider-fixture" });
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0][1]).toMatchObject({ workspaceId, stage: "storage", quantity: 1,
    unitCostUsd: null, bytes: null, details: { uploadId: sessionId, operation: "CreateMultipartUpload" } });
  expect(send).toHaveBeenCalledTimes(1);
});

it("loads configured request prices before recording factory calls", async () => {
  fixtureEnv.STORAGE_MULTIPART_REQUEST_PRICING_JSON = JSON.stringify({ evidenceId: "test-only-price", pricesPerRequestUsd: { CreateMultipartUpload: 0.125 } });
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({ UploadId: "provider-fixture" }));
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  await getStorageProvider().multipart!.create({ key: `src/${workspaceId}/multipart-${sessionId}`, sessionId,
    partBytes: 5242880, totalBytes: 3 });
  expect(record.mock.calls[0][1]).toMatchObject({ unitCostUsd: 0.125, details: { pricingEvidenceId: "test-only-price" } });
});
it("refuses invalid price configuration before provider requests", () => {
  fixtureEnv.STORAGE_MULTIPART_REQUEST_PRICING_JSON = "invalid fixture";
  const send = vi.spyOn(S3Client.prototype, "send");
  expect(() => getStorageProvider()).toThrow("MULTIPART_REQUEST_PRICING_INVALID");
  expect(send).not.toHaveBeenCalled();
});
