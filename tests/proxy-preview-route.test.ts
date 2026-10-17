import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), verify: vi.fn(), identity: vi.fn(), storage: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { derivedMediaArtifact: { findFirst: mocks.findFirst } } }));
vi.mock("@/lib/media/signed-url", () => ({ verifySignedMediaUrl: mocks.verify }));
vi.mock("@/lib/storage", () => ({ getStorageProvider: mocks.storage }));
import { GET } from "@/app/api/media/artifact/route";
let root: string;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(os.tmpdir(), "proxy-route-"));
  const file = path.join(root, "proxy");
  await writeFile(file, "abcdefghij");
  mocks.verify.mockReturnValue({ ok: true, contentType: "video/mp4", workspaceId, key: `${workspaceId}/artifact-preview/${artifactId}`,
    expiresAt: Math.floor(Date.now() / 1000) + 60 });
  mocks.findFirst.mockResolvedValue({ id: artifactId, storageKey: "sources/source/artifacts/proxy.mp4", sha256: "sha",
    byteCount: BigInt(10), expiresAt: null, publicationEvidence: { storageIdentity: "store", sha256: "sha",
      byteCount: "10", objectIdentity: { token: "object", byteCount: 10 } } });
  mocks.identity.mockResolvedValue({ token: "object", byteCount: 10 });
  mocks.storage.mockReturnValue({ getStorageIdentity: () => "store", getObjectIdentity: mocks.identity, absolutePath: () => file });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const request = (range?: string) => new Request("http://localhost/api/media/artifact", { headers: range ? { range } : {} });

it.each([["bytes=2-4", "cde"], ["bytes=7-", "hij"], ["bytes=-3", "hij"], ["bytes=8-100", "ij"]])(
  "serves authenticated registry proxy ranges (%s)", async (range, body) => {
    const response = await GET(request(range));
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body);
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: artifactId, sourceVideo: { workspaceId }, kind: "SOURCE_PROXY", publicationState: "READY", deletedAt: null,
    }) }));
  });
it("refuses invalid signatures before database access", async () => {
  mocks.verify.mockReturnValue({ ok: false, reason: "invalid" });
  expect((await GET(request())).status).toBe(403);
  expect(mocks.findFirst).not.toHaveBeenCalled();
});
it("refuses missing, deleted, expired, or foreign registry rows", async () => {
  mocks.findFirst.mockResolvedValue(null);
  expect((await GET(request())).status).toBe(404);
  expect(mocks.storage).not.toHaveBeenCalled();
});
it("refuses changed storage objects", async () => {
  mocks.identity.mockResolvedValue({ token: "changed", byteCount: 10 });
  expect((await GET(request())).status).toBe(409);
});
it.each(["bytes=-0", "bytes=20-30", "bytes=5-3", "bytes=", "bytes=1-2,4-5"])("refuses invalid range %s", async range => {
  expect((await GET(request(range))).status).toBe(416);
});
it("signs the registered object for remote playback after identity checks", async () => {
  const sign = vi.fn().mockResolvedValue("https://storage.example.test/proxy");
  mocks.storage.mockReturnValue({ getStorageIdentity: () => "store", getObjectIdentity: mocks.identity, createSignedReadUrl: sign });
  const response = await GET(request());
  expect(response.status).toBe(307);
  expect(sign).toHaveBeenCalledWith("sources/source/artifacts/proxy.mp4", expect.objectContaining({ contentType: "video/mp4" }));
});

it("serves image artifacts with a restricted image-kind query", async () => {
  mocks.verify.mockReturnValue({ ...mocks.verify(), contentType: "image/webp" });
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/webp");
  expect(await response.text()).toBe("abcdefghij");
  expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
    kind: { in: ["TIMELINE_VIEW", "BOUNDARY_STRIP"] }, derivationVersion: "proxy-contact-sheet-v2",
  }) }));
});
it("refuses unsupported signed content types before database access", async () => {
  mocks.verify.mockReturnValue({ ...mocks.verify(), contentType: "text/html" });
  expect((await GET(request())).status).toBe(403);
  expect(mocks.findFirst).not.toHaveBeenCalled();
});
