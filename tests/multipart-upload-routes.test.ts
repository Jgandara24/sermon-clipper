import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  auth: vi.fn(), rate: vi.fn(), event: vi.fn(), storage: {}, kind: vi.fn(),
  register: vi.fn(), start: vi.fn(), list: vi.fn(), sign: vi.fn(), complete: vi.fn(), abort: vi.fn(),
  lookup: vi.fn(), signed: vi.fn(), verify: vi.fn(),
}));
vi.mock("@/lib/api/auth", () => ({ requireApiWorkspace: f.auth }));
vi.mock("@/lib/prisma", () => ({ prisma: { multipartUpload: { findFirst: f.lookup } } }));
vi.mock("@/lib/storage", () => ({ getStorageProvider: () => f.storage, storageProviderKind: f.kind,
  StorageLimitExceededError: class extends Error {} }));
vi.mock("@/lib/rate-limit", () => ({ checkUploadPresignLimit: f.rate }));
vi.mock("@/lib/observability/operational-events", () => ({ recordOperationalEvent: f.event, recordOperationalEventSafely: vi.fn() }));
vi.mock("@/lib/media/signed-url", () => ({ createSignedUploadUrl: f.signed, verifySignedUploadUrl: f.verify, DEFAULT_UPLOAD_URL_TTL_SECONDS: 900 }));
vi.mock("@/lib/uploads/multipart-session", () => ({ registerMultipartUpload: f.register, initiateMultipartUpload: f.start,
  listMultipartUploadParts: f.list, signMultipartUploadPart: f.sign, completeMultipartUpload: f.complete, abortMultipartUpload: f.abort }));
vi.mock("@/lib/cost/direct-upload", () => ({ recordDirectUploadCostFactsSafely: vi.fn() }));
import { POST as presign } from "@/app/api/uploads/presign/route";
import { POST as control } from "@/app/api/uploads/[uploadId]/multipart/route";
import { POST as relayComplete } from "@/app/api/uploads/[uploadId]/complete/route";
import { PUT as relayPut } from "@/app/api/uploads/[uploadId]/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const uploadId = "22222222-2222-4222-8222-222222222222";
const params = { params: Promise.resolve({ uploadId }) };
const row = { id: uploadId, partBytes: BigInt(5242880), totalBytes: BigInt(3), expiresAt: new Date("2030-01-01"), state: "UPLOADING" };
function request(body: unknown) {
  return new Request("https://app.example.test/api/uploads/fixture", { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" } });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("P4_DIRECT_MULTIPART_UPLOAD_ENABLED", "true");
  vi.stubEnv("P4_MULTIPART_PART_BYTES", "5242880");
  vi.stubEnv("P4_MULTIPART_LIFETIME_SECONDS", "3600");
  f.auth.mockResolvedValue({ workspace: { id: workspaceId, planCode: "trial" } });
  f.kind.mockReturnValue("s3");
  f.rate.mockResolvedValue({ allowed: true });
  f.register.mockResolvedValue(row);
  f.start.mockResolvedValue(row);
  f.list.mockResolvedValue({ parts: [] });
  f.sign.mockResolvedValue("https://storage.example.test/signed-part");
  f.complete.mockResolvedValue({ id: "source-fixture" });
  f.signed.mockReturnValue("https://app.example.test/signed-relay");
  f.lookup.mockResolvedValue({ id: uploadId });
  f.verify.mockReturnValue({ ok: true, workspaceId, maxBytes: 100 });
});
afterEach(() => vi.unstubAllEnvs());

describe("multipart registration route", () => {
  it("records the existing rate counter before registration and returns no relay URL", async () => {
    f.register.mockImplementation(async () => { expect(f.event).toHaveBeenCalledTimes(1); return row; });
    const response = await presign(request({ filename: "service.mp4", size: 3 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { uploadId, transport: "multipart", partBytes: 5242880,
      totalBytes: 3, expiresAt: "2030-01-01T00:00:00.000Z" } });
    expect(f.register).toHaveBeenCalledWith(expect.anything(), f.storage, expect.objectContaining({ workspaceId,
      filename: "service.mp4", totalBytes: 3, partBytes: 5242880 }));
    expect(f.signed).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it.each(["local", "explicit", "disabled"])("keeps the relay for %s", async mode => {
    if (mode === "local") f.kind.mockReturnValue("local");
    if (mode === "disabled") vi.stubEnv("P4_DIRECT_MULTIPART_UPLOAD_ENABLED", "false");
    const response = await presign(request({ filename: "service.mp4", size: 3, ...(mode === "explicit" ? { transport: "relay" } : {}) }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ transport: "relay", uploadUrl: "https://app.example.test/signed-relay" });
    expect(f.register).not.toHaveBeenCalled();
  });
  it("does not fall back to relay after invalid multipart configuration", async () => {
    vi.stubEnv("P4_MULTIPART_PART_BYTES", "");
    const response = await presign(request({ filename: "service.mp4", size: 3 }));
    expect(response.status).toBe(503);
    expect(f.register).not.toHaveBeenCalled();
    expect(f.signed).not.toHaveBeenCalled();
  });
  it.each(["rate", "plan", "counter"])("refuses registration after %s failure", async mode => {
    if (mode === "rate") f.rate.mockResolvedValue({ allowed: false, message: "fixture limit" });
    if (mode === "counter") {
      f.event.mockRejectedValue(new Error("fixture counter failure"));
      vi.spyOn(console, "error").mockImplementation(() => {});
    }
    try {
      const response = await presign(request({ filename: "service.mp4", size: mode === "plan" ? 6 * 1024 ** 3 : 3 }));
      expect(response.status).toBe(mode === "plan" ? 413 : mode === "rate" ? 429 : 500);
      expect(f.register).not.toHaveBeenCalled();
      expect(f.signed).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
});

describe("multipart controls", () => {
  it.each(["start", "list", "sign", "complete", "abort"])("requires workspace permission for %s", async action => {
    f.auth.mockResolvedValue({ error: new Response(null, { status: 403 }) });
    const response = await control(request({ action, ...(action === "sign" ? { partNumber: 1 } : {}) }), params);
    expect(response.status).toBe(403);
    for (const operation of [f.start, f.list, f.sign, f.complete, f.abort]) expect(operation).not.toHaveBeenCalled();
  });
  it.each(["start", "list", "sign", "complete", "abort"])("passes only server workspace ownership to %s", async action => {
    const response = await control(request({ action, ...(action === "sign" ? { partNumber: 1 } : {}) }), params);
    expect(response.status).toBe(200);
    const operation = action === "start" ? f.start : action === "list" ? f.list : action === "sign" ? f.sign : action === "complete" ? f.complete : f.abort;
    expect(operation).toHaveBeenCalledWith(expect.anything(), f.storage, expect.objectContaining({ id: uploadId, workspaceId }));
    expect(f.auth).toHaveBeenCalledWith("IMPORT_MEDIA");
    if (action === "sign" || action === "list") expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each([
    { action: "sign", partNumber: 0 }, { action: "sign", partNumber: 10001 },
    { action: "sign", partNumber: 1, workspaceId: "attacker" },
    { action: "complete", totalBytes: 1 }, { action: "complete", parts: [] }, { action: "unknown" },
  ])("refuses client control of persisted facts %j", async body => {
    expect((await control(request(body), params)).status).toBe(400);
    for (const operation of [f.start, f.list, f.sign, f.complete, f.abort]) expect(operation).not.toHaveBeenCalled();
  });
  it("refuses an invalid upload ID before service access", async () => {
    expect((await control(request({ action: "start" }), { params: Promise.resolve({ uploadId: "bad" }) })).status).toBe(400);
    expect(f.start).not.toHaveBeenCalled();
  });
  it.each([
    ["MULTIPART_UPLOAD_NOT_FOUND", 404], ["MULTIPART_UPLOAD_EXPIRED", 410],
    ["MULTIPART_UPLOAD_UNCERTAIN", 409], ["MULTIPART_INCOMPLETE", 409],
    ["private signed URL and credentials", 503],
  ])("maps service error %s without provider details", async (message, status) => {
    f.complete.mockRejectedValue(new Error(String(message)));
    const response = await control(request({ action: "complete" }), params);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(String(message));
  });
  it("allows an existing session to abort after creation rollout stops", async () => {
    vi.stubEnv("P4_DIRECT_MULTIPART_UPLOAD_ENABLED", "false");
    expect((await control(request({ action: "abort" }), params)).status).toBe(200);
    expect(f.abort).toHaveBeenCalledTimes(1);
  });
});

it("rejects relay completion for a multipart record before storage access", async () => {
  const response = await relayComplete(request({ filename: "service.mp4", size: 3 }), params);
  expect(response.status).toBe(409);
  expect(f.lookup).toHaveBeenCalledWith({ where: { id: uploadId, workspaceId }, select: { id: true } });
});
it("rejects relay byte writes for a multipart record", async () => {
  const response = await relayPut(new Request("https://app.example.test/api/uploads/fixture", { method: "PUT", body: "bytes" }), params);
  expect(response.status).toBe(409);
  expect(f.lookup).toHaveBeenCalledWith({ where: { id: uploadId, workspaceId }, select: { id: true } });
});
