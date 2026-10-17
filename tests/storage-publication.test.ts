import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDiskStorageProvider } from "@/lib/storage/local-disk-provider";
import { CachedStorageProvider } from "@/lib/storage/cached-provider";
import type { StorageProvider } from "@/lib/storage/types";

const fixture = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async importOriginal => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return { ...actual, S3Client: class { send = fixture.send; } };
});
import { S3StorageProvider } from "@/lib/storage/s3-provider";

let root: string;
let source: string;
let local: LocalDiskStorageProvider;
beforeEach(async () => {
  fixture.send.mockReset();
  root = await mkdtemp(path.join(os.tmpdir(), "storage-publication-"));
  source = path.join(root, "input");
  await writeFile(source, "first");
  local = new LocalDiskStorageProvider(path.join(root, "storage"));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe("conditional artifact publication", () => {
  it("identifies storage scope independently of credentials and the cache wrapper", async () => {
    const options = { bucket: "fixture", region: "auto", endpoint: "https://storage.example.test", accessKeyId: "one", secretAccessKey: "one" };
    const first = new S3StorageProvider(options);
    expect(new S3StorageProvider({ ...options, accessKeyId: "two", secretAccessKey: "two" }).getStorageIdentity()).toBe(first.getStorageIdentity());
    expect(new S3StorageProvider({ ...options, bucket: "other" }).getStorageIdentity()).not.toBe(first.getStorageIdentity());
    expect(new S3StorageProvider({ ...options, endpoint: "https://other.example.test" }).getStorageIdentity()).not.toBe(first.getStorageIdentity());
    expect(new LocalDiskStorageProvider(path.join(root, "other")).getStorageIdentity()).not.toBe(local.getStorageIdentity());
    const cache = new CachedStorageProvider(local, { root: path.join(root, "cache"), maxBytes: 100 });
    try { expect(cache.getStorageIdentity!()).toBe(local.getStorageIdentity()); }
    finally { await cache.close(); }
  });
  it("does not report storage errors as confirmed absence", async () => {
    await local.uploadFileIfAbsent("parent-file", source);
    await expect(local.exists("parent-file/child")).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await local.exists("missing")).toBe(false);
  });
  it("allows one concurrent local writer and preserves its complete bytes", async () => {
    const sources = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const file = path.join(root, `source-${index}`);
      await writeFile(file, String(index).repeat(100_000));
      return file;
    }));
    const results = await Promise.allSettled(sources.map(file => local.uploadFileIfAbsent("artifact", file)));
    const winner = results.findIndex(result => result.status === "fulfilled");
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason.code).toBe("EEXIST");
    }
    expect(await local.readAsBuffer("artifact")).toEqual(await readFile(sources[winner]));
    await writeFile(sources[winner], "changed");
    expect((await local.readAsBuffer("artifact")).length).toBe(100_000);
    expect(await readdir(path.join(root, "storage"))).toEqual(["artifact"]);
  });
  it("cleans staging after a failed copy without creating a destination", async () => {
    await expect(local.uploadFileIfAbsent("artifact", path.join(root, "missing"))).rejects.toThrow();
    expect(await local.exists("artifact")).toBe(false);
    expect(await readdir(path.join(root, "storage"))).toEqual([]);
  });
  it("refuses keys outside the storage root", async () => {
    await expect(local.uploadFileIfAbsent("../escape", source)).rejects.toThrow("escapes root");
  });
  it("preserves cached bytes when a conflicting publication fails", async () => {
    const cache = new CachedStorageProvider(local, { root: path.join(root, "cache"), maxBytes: 100 });
    try {
      await cache.uploadFileIfAbsent!("artifact", source);
      const destination = path.join(root, "download");
      await cache.downloadToFile("artifact", destination);
      await writeFile(source, "second");
      await expect(cache.uploadFileIfAbsent!("artifact", source)).rejects.toThrow();
      await cache.downloadToFile("artifact", destination);
      expect(await readFile(destination, "utf8")).toBe("first");
    } finally { await cache.close(); }
  });
  it("does not invent conditional capability for an unsupported provider", async () => {
    const unsupported: StorageProvider = Object.create(local);
    unsupported.uploadFileIfAbsent = undefined;
    const cache = new CachedStorageProvider(unsupported, { root: path.join(root, "cache"), maxBytes: 100 });
    try { expect(cache.uploadFileIfAbsent).toBeUndefined(); }
    finally { await cache.close(); }
  });
  it("sends one conditional PUT with the file size and content type", async () => {
    fixture.send.mockImplementation(async command => {
      const chunks: Buffer[] = [];
      for await (const chunk of command.input.Body) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe("first");
      return {};
    });
    const s3 = new S3StorageProvider({ bucket: "fixture", region: "auto", accessKeyId: "fixture", secretAccessKey: "fixture" });
    await s3.uploadFileIfAbsent("artifact", source, "audio/flac");
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send.mock.calls[0][0].constructor.name).toBe("PutObjectCommand");
    expect(fixture.send.mock.calls[0][0].input).toMatchObject({
      Bucket: "fixture", Key: "artifact", IfNoneMatch: "*", ContentLength: 5, ContentType: "audio/flac",
    });
  });
  it.each(["PreconditionFailed", "EntityTooLarge", "network failure"])(
    "propagates %s without an unconditional or multipart fallback", async message => {
      fixture.send.mockRejectedValue(new Error(message));
      const s3 = new S3StorageProvider({ bucket: "fixture", region: "auto", accessKeyId: "fixture", secretAccessKey: "fixture" });
      await expect(s3.uploadFileIfAbsent("artifact", source)).rejects.toThrow(message);
      expect(fixture.send).toHaveBeenCalledTimes(1);
      expect(fixture.send.mock.calls[0][0].input.Body.destroyed).toBe(true);
    },
  );
});
