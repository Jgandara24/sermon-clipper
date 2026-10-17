import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async importOriginal => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return { ...actual, S3Client: class { send = fixture.send; } };
});
import { S3StorageProvider } from "@/lib/storage/s3-provider";

let root: string;
const provider = new S3StorageProvider({ bucket: "fixture", region: "auto", accessKeyId: "fixture", secretAccessKey: "fixture" });
const identity = { token: '["etag","version",4]', byteCount: 4, etag: "etag", versionId: "version" };

beforeEach(async () => {
  fixture.send.mockReset();
  root = await mkdtemp(path.join(os.tmpdir(), "s3-identity-"));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe("S3 conditional source materialization", () => {
  it("uses ETag, version ID, and size as the reusable identity", async () => {
    fixture.send.mockResolvedValue({ ETag: "etag", VersionId: "version", ContentLength: 4 });
    expect(await provider.getObjectIdentity("source")).toEqual(identity);
    expect(fixture.send.mock.calls[0][0].input).toEqual({ Bucket: "fixture", Key: "source" });
  });
  it.each([{ ContentLength: 4 }, { ETag: "etag" }, { ETag: "etag", ContentLength: -1 }])(
    "refuses incomplete identity: %j", async response => {
      fixture.send.mockResolvedValue(response);
      expect(await provider.getObjectIdentity("source")).toBeNull();
    },
  );
  it("pins the GET to the inspected object version", async () => {
    fixture.send.mockResolvedValue({ ETag: "etag", VersionId: "version", Body: Readable.from([Buffer.from("1234")]) });
    const target = path.join(root, "source");
    await provider.downloadToFile("source", target, identity);
    expect(fixture.send.mock.calls[0][0].input).toMatchObject({ IfMatch: "etag", VersionId: "version" });
    expect(await readFile(target, "utf8")).toBe("1234");
  });
  it("does not retry a failed precondition as an unconditional download", async () => {
    fixture.send.mockRejectedValue(new Error("PreconditionFailed"));
    await expect(provider.downloadToFile("source", path.join(root, "source"), identity)).rejects.toThrow("PreconditionFailed");
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });
  it.each([{ ETag: "wrong", VersionId: "version" }, { ETag: "etag", VersionId: "wrong" }])(
    "rejects response identity mismatch: %j", async response => {
      const body = Readable.from([Buffer.from("1234")]);
      fixture.send.mockResolvedValue({ ...response, Body: body });
      await expect(provider.downloadToFile("source", path.join(root, "source"), identity)).rejects.toThrow("identity");
      expect(body.destroyed).toBe(true);
    },
  );
  it.each(["12", "12345678"])("removes partial output after a size mismatch: %s", async bytes => {
    fixture.send.mockResolvedValue({ ETag: "etag", VersionId: "version", Body: Readable.from([Buffer.from(bytes)]) });
    const target = path.join(root, "source");
    await expect(provider.downloadToFile("source", target, identity)).rejects.toThrow("declared size");
    await expect(readFile(target)).rejects.toThrow();
  });
});
