import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CachedStorageProvider } from "@/lib/storage/cached-provider";
import { LocalDiskStorageProvider } from "@/lib/storage/local-disk-provider";
import { storageTransferCostFact } from "@/lib/storage";
import type { MultipartStorage } from "@/lib/storage/multipart";
import type { StorageObjectIdentity } from "@/lib/storage/types";

let root: string;
let provider: CountingStorage;
let cache: CachedStorageProvider;

class CountingStorage extends LocalDiskStorageProvider {
  multipart?: MultipartStorage;
  downloads = 0;
  beforeDownload?: () => Promise<void>;
  fail = false;
  async downloadToFile(key: string, destination: string, expected?: StorageObjectIdentity) {
    this.downloads++;
    await this.beforeDownload?.();
    if (this.fail) {
      await writeFile(destination, "partial");
      throw new Error("Fixture transfer failure");
    }
    return super.downloadToFile(key, destination, expected);
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "storage-cache-test-"));
  provider = new CountingStorage(path.join(root, "storage"));
  await mkdir(path.join(root, "storage"));
  cache = new CachedStorageProvider(provider, { root: path.join(root, "cache"), maxBytes: 8 });
});
afterEach(async () => {
  await cache.close();
  await rm(root, { recursive: true, force: true });
});
async function put(key: string, value = "1234") { await writeFile(provider.absolutePath(key), value); }
function destination(name = "caller") { return path.join(root, name, "source"); }
async function cacheFiles() {
  const sessions = await readdir(path.join(root, "cache")).catch(() => []);
  return (await Promise.all(sessions.map(async session => {
    const directory = path.join(root, "cache", session);
    return (await readdir(directory)).map(file => path.join(directory, file));
  }))).flat();
}

describe("content-identified storage cache", () => {
  it("does not add multipart support to local storage", () => {
    expect(cache.multipart).toBeUndefined();
  });

  it.each([false, true])("invalidates cached bytes after multipart completion (uncertain=%s)", async uncertain => {
    await put("a");
    await cache.downloadToFile("a", destination());
    expect(await cacheFiles()).toHaveLength(1);
    const adapter: MultipartStorage = {
      async inspectAborted() { expect(this).toBe(adapter); return false; },
      async findInitiated() { expect(this).toBe(adapter); return null; },
      async inspectCompleted() { expect(this).toBe(adapter); return null; },
      async create() { expect(this).toBe(adapter); return { uploadId: "fixture" }; },
      async signPart() { expect(this).toBe(adapter); return "fixture-url"; },
      async listParts() { expect(this).toBe(adapter); return []; },
      async abort() { expect(this).toBe(adapter); },
      async complete() {
        expect(this).toBe(adapter);
        if (uncertain) throw new Error("uncertain completion");
        return { etag: "fixture", byteCount: 4 };
      },
    };
    provider.multipart = adapter;
    const session = { key: "a", sessionId: "fixture", uploadId: "fixture", totalBytes: 4, partBytes: 5 * 1024 * 1024 };
    const multipart = cache.multipart!;
    await multipart.inspectAborted(session);
    await multipart.findInitiated(session);
    await multipart.inspectCompleted(session);
    await multipart.create(session);
    await multipart.signPart(session, 1, 60);
    await multipart.listParts(session);
    await multipart.abort(session);
    if (uncertain) await expect(multipart.complete(session)).rejects.toThrow("uncertain completion");
    else await expect(multipart.complete(session)).resolves.toEqual({ etag: "fixture", byteCount: 4 });
    expect(await cacheFiles()).toHaveLength(0);
    await cache.downloadToFile("a", destination("after-completion"));
    expect(provider.downloads).toBe(2);
  });

  it("shares one acquisition across concurrent callers and meters only its owner", async () => {
    await put("a");
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => cache.downloadToFile("a", destination(String(index)))));
    expect(provider.downloads).toBe(1);
    expect(results.reduce((sum, result) => sum + result.transferredBytes, 0)).toBe(4);
    expect(results.filter(result => result.cacheState === "miss")).toHaveLength(1);
    for (let index = 0; index < results.length; index++) expect(await readFile(destination(String(index)), "utf8")).toBe("1234");
  });

  it("survives caller deletion and caller mutation without changing cached bytes", async () => {
    await put("a");
    await cache.downloadToFile("a", destination());
    await writeFile(destination(), "changed");
    await rm(path.dirname(destination()), { recursive: true });
    expect(await cache.downloadToFile("a", destination("second"))).toEqual({ transferredBytes: 0, cacheState: "hit" });
    expect(await readFile(destination("second"), "utf8")).toBe("1234");
  });

  it("evicts the least recently used unpinned object by bytes", async () => {
    await put("a"); await put("b"); await put("c");
    await cache.downloadToFile("a", destination());
    await cache.downloadToFile("b", destination());
    await cache.downloadToFile("a", destination());
    await cache.downloadToFile("c", destination());
    expect((await cache.downloadToFile("a", destination())).cacheState).toBe("hit");
    expect((await cache.downloadToFile("b", destination())).cacheState).toBe("miss");
    expect(provider.downloads).toBe(4);
    expect(await cacheFiles()).toHaveLength(2);
  });

  it("checks content identity even when replacement bytes have the same size", async () => {
    await put("a");
    await cache.downloadToFile("a", destination());
    await put("a", "9876");
    expect((await cache.downloadToFile("a", destination())).cacheState).toBe("miss");
    expect(await readFile(destination(), "utf8")).toBe("9876");
  });

  it("does not return cached bytes after an external deletion", async () => {
    await put("a"); await cache.downloadToFile("a", destination());
    await provider.remove("a");
    await expect(cache.downloadToFile("a", destination("missing"))).rejects.toThrow();
  });

  it("rejects source replacement between identity inspection and download", async () => {
    await put("a");
    provider.beforeDownload = async () => put("a", "5678");
    await expect(cache.downloadToFile("a", destination())).rejects.toThrow("changed");
    expect(await cacheFiles()).toEqual([]);
  });

  it.each(["12", "123456789012345"])("rejects a transfer with changed length: %s", async value => {
    await put("a");
    provider.beforeDownload = async () => put("a", value);
    await expect(cache.downloadToFile("a", destination())).rejects.toThrow("declared size");
    expect(await cacheFiles()).toEqual([]);
  });

  it("removes failed partial transfers and permits a later retry", async () => {
    await put("a"); provider.fail = true;
    await expect(cache.downloadToFile("a", destination())).rejects.toThrow("Fixture transfer failure");
    expect(await cacheFiles()).toEqual([]);
    provider.fail = false;
    await cache.downloadToFile("a", destination());
    expect(provider.downloads).toBe(2);
  });

  it("detects corrupted cache bytes and removes the invalid caller copy", async () => {
    await put("a"); await cache.downloadToFile("a", destination());
    await writeFile((await cacheFiles())[0], "9876");
    await expect(cache.downloadToFile("a", destination("corrupt"))).rejects.toMatchObject({
      message: "Cached storage bytes failed verification.", download: { transferredBytes: 0, cacheState: "hit" },
    });
    await expect(readFile(destination("corrupt"))).rejects.toThrow();
    expect(await cacheFiles()).toEqual([]);
    await cache.downloadToFile("a", destination());
    expect(provider.downloads).toBe(2);
  });

  it("bypasses objects larger than capacity without retaining their bytes", async () => {
    await put("big", "123456789");
    expect(await cache.downloadToFile("big", destination())).toEqual({ transferredBytes: 9, cacheState: "not_applicable" });
    expect(await cacheFiles()).toEqual([]);
  });

  it("pins active downloads, bypasses capacity pressure, and waits on close", async () => {
    await put("a", "12345678"); await put("b");
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    provider.beforeDownload = async () => { entered(); await gate; };
    const first = cache.downloadToFile("a", destination("first"));
    await started;
    provider.beforeDownload = undefined;
    expect((await cache.downloadToFile("b", destination("second"))).cacheState).toBe("not_applicable");
    let closed = false;
    const closing = cache.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(cache.downloadToFile("a", destination("late"))).rejects.toThrow("closed");
    release();
    await first; await closing;
    expect(await cacheFiles()).toEqual([]);
    expect(await readFile(destination("first"), "utf8")).toBe("12345678");
  });

  it("invalidates owned writes, moves, and removals while retaining local signing behavior", async () => {
    await put("a"); await cache.downloadToFile("a", destination());
    expect(cache.createSignedReadUrl).toBeUndefined();
    await cache.writeFromWebStream("a", new Blob(["5678"]).stream(), 4);
    expect(await cacheFiles()).toEqual([]);
    await cache.downloadToFile("a", destination());
    await cache.move("a", "b");
    expect(await cacheFiles()).toEqual([]);
    await cache.downloadToFile("b", destination());
    await cache.remove("b");
    expect(await cacheFiles()).toEqual([]);
  });

  it("does not charge cached bytes as another remote download", () => {
    expect(storageTransferCostFact({ direction: "download", bytes: 4000, provider: "s3",
      configuredPricePerGbUsd: 1, wallTimeMs: 2, attempt: 1, outcome: "succeeded",
      download: { transferredBytes: 0, cacheState: "hit" },
    })).toMatchObject({ bytes: 0, quantity: 0, cacheState: "hit" });
  });
});
