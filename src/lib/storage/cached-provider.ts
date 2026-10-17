import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileIdentity } from "./file-identity";
import type { StorageDownloadResult, StorageObjectIdentity, StorageProvider } from "./types";
import { StorageDownloadError } from "./types";

type Entry = {
  id: string; key: string; file: string; bytes: number; users: number; touched: number;
  ready: Promise<string>; failed: boolean; retired: boolean;
};

/** Process-local cache. Copies, never hardlinks, protect cached bytes from caller writes. */
export class CachedStorageProvider implements StorageProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Set<Promise<unknown>>();
  private serial: Promise<unknown> = Promise.resolve();
  private directory?: string;
  private usedBytes = 0;
  private sequence = 0;
  private closed = false;

  constructor(private readonly provider: StorageProvider, private readonly options: { root: string; maxBytes: number }) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new Error("Cache capacity must be a positive integer.");
  }

  private locked<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action);
    this.serial = result.catch(() => {});
    return result;
  }

  private async discard(entry: Entry) {
    await rm(entry.file, { force: true });
    this.entries.delete(entry.id);
    this.usedBytes -= entry.bytes;
  }

  private async acquire(key: string, identity: StorageObjectIdentity): Promise<{ entry: Entry; owner: boolean } | null> {
    return this.locked(async () => {
      const id = JSON.stringify([key, identity.token, identity.byteCount]);
      const existing = this.entries.get(id);
      if (existing && !existing.failed && !existing.retired) {
        existing.users++;
        existing.touched = ++this.sequence;
        return { entry: existing, owner: false };
      }
      // A failed/retired entry with active readers cannot be replaced under the same identity.
      if (existing) return null;
      if (identity.byteCount === 0 || identity.byteCount > this.options.maxBytes) return null;
      while (this.usedBytes + identity.byteCount > this.options.maxBytes) {
        const victim = [...this.entries.values()].filter(entry => entry.users === 0)
          .sort((a, b) => a.touched - b.touched)[0];
        if (!victim) return null;
        await this.discard(victim);
      }
      if (!this.directory) {
        await mkdir(this.options.root, { recursive: true });
        this.directory = await mkdtemp(path.join(this.options.root, "session-"));
      }
      const entry: Entry = {
        id, key, file: path.join(this.directory, randomUUID()), bytes: identity.byteCount,
        users: 1, touched: ++this.sequence, ready: Promise.resolve(""), failed: false, retired: false,
      };
      this.usedBytes += identity.byteCount;
      this.entries.set(id, entry);
      entry.ready = this.fill(entry, identity).catch(error => { entry.failed = true; throw error; });
      // The reader observes failures. This handler also covers the short acquisition handoff.
      void entry.ready.catch(() => {});
      return { entry, owner: true };
    });
  }

  private async fill(entry: Entry, identity: StorageObjectIdentity): Promise<string> {
    await this.provider.downloadToFile(entry.key, entry.file, identity);
    const actual = await fileIdentity(entry.file);
    if (actual.byteCount !== identity.byteCount || (identity.sha256 && actual.sha256 !== identity.sha256)) {
      throw new Error("Cached download does not match object identity.");
    }
    return actual.sha256;
  }

  downloadToFile(key: string, destinationPath: string, expected?: StorageObjectIdentity): Promise<StorageDownloadResult> {
    if (this.closed) return Promise.reject(new Error("Storage cache is closed."));
    const operation = this.materialize(key, destinationPath, expected);
    this.active.add(operation);
    void operation.finally(() => this.active.delete(operation)).catch(() => {});
    return operation;
  }

  private async materialize(key: string, destinationPath: string, expected?: StorageObjectIdentity): Promise<StorageDownloadResult> {
    const identity = await this.provider.getObjectIdentity?.(key);
    if (identity && (!identity.token || !Number.isSafeInteger(identity.byteCount) || identity.byteCount < 0)) {
      throw new Error("Invalid storage object identity.");
    }
    if (identity && expected && (expected.token !== identity.token || expected.byteCount !== identity.byteCount)) {
      throw new Error("Storage object changed before materialization.");
    }
    const acquired = identity ? await this.acquire(key, identity) : null;
    if (!acquired) {
      const result = await this.provider.downloadToFile(key, destinationPath, identity ?? expected);
      return result ?? { transferredBytes: (await stat(destinationPath)).size, cacheState: "not_applicable" };
    }
    const { entry, owner } = acquired;
    let completedTransfer = false;
    try {
      const checksum = await entry.ready;
      completedTransfer = true;
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(entry.file, destinationPath);
      // Verify the actual caller copy, including corruption during copying.
      const actual = await fileIdentity(destinationPath);
      if (actual.sha256 !== checksum || actual.byteCount !== entry.bytes) {
        entry.failed = true;
        await rm(destinationPath, { force: true });
        throw new Error("Cached storage bytes failed verification.");
      }
      return { transferredBytes: owner ? entry.bytes : 0, cacheState: owner ? "miss" : "hit" };
    } catch (error) {
      // Failed acquisitions can have unknown partial transfer bytes. Never call that a cache hit.
      const download = !owner ? { transferredBytes: 0, cacheState: "hit" as const }
        : completedTransfer ? { transferredBytes: entry.bytes, cacheState: "miss" as const } : undefined;
      throw new StorageDownloadError(error, download);
    } finally {
      await this.locked(async () => {
        entry.users--;
        if (entry.users === 0 && (entry.failed || entry.retired)) await this.discard(entry);
      });
    }
  }

  private async invalidate(key: string) {
    await this.locked(async () => {
      for (const entry of this.entries.values()) {
        if (entry.key !== key) continue;
        entry.retired = true;
        if (entry.users === 0) await this.discard(entry);
      }
    });
  }

  /** Wait for owned downloads/copies, then remove only this instance's directory. */
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.active]);
    await this.locked(async () => {
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
      this.entries.clear();
      this.usedBytes = 0;
    });
  }

  get multipart() {
    const multipart = this.provider.multipart;
    if (!multipart) return undefined;
    return {
      inspectCompleted: multipart.inspectCompleted.bind(multipart),
      findInitiated: multipart.findInitiated.bind(multipart),
      inspectAborted: multipart.inspectAborted.bind(multipart),
      create: multipart.create.bind(multipart),
      signPart: multipart.signPart.bind(multipart),
      listParts: multipart.listParts.bind(multipart),
      abort: multipart.abort.bind(multipart),
      complete: async (...args: Parameters<typeof multipart.complete>) => {
        try { return await multipart.complete(...args); }
        finally { await this.invalidate(args[0].key); }
      },
    };
  }

  get getStorageIdentity() { return this.provider.getStorageIdentity?.bind(this.provider); }
  absolutePath(key: string) { return this.provider.absolutePath(key); }
  exists(key: string) { return this.provider.exists(key); }
  size(key: string) { return this.provider.size(key); }
  getObjectIdentity(key: string) { return this.provider.getObjectIdentity?.(key) ?? Promise.resolve(null); }
  list(prefix: string) { return this.provider.list(prefix); }
  readAsBuffer(key: string) { return this.provider.readAsBuffer(key); }
  readRange(key: string, start: number, end: number) { return this.provider.readRange(key, start, end); }
  // Keep optional signing optional; local storage must retain its signed-route fallback.
  get createSignedReadUrl() { return this.provider.createSignedReadUrl?.bind(this.provider); }
  get uploadFileIfAbsent() {
    const upload = this.provider.uploadFileIfAbsent?.bind(this.provider);
    if (!upload) return undefined;
    return async (key: string, sourcePath: string, contentType?: string) => {
      try { await upload(key, sourcePath, contentType); }
      finally { await this.invalidate(key); }
    };
  }

  async writeFromWebStream(key: string, body: ReadableStream<Uint8Array>, maxBytes: number) {
    try { return await this.provider.writeFromWebStream(key, body, maxBytes); }
    finally { await this.invalidate(key); }
  }
  async uploadFile(key: string, sourcePath: string, contentType?: string) {
    try { await this.provider.uploadFile(key, sourcePath, contentType); }
    finally { await this.invalidate(key); }
  }
  async move(fromKey: string, toKey: string) {
    try { await this.provider.move(fromKey, toKey); }
    finally { await this.invalidate(fromKey); await this.invalidate(toKey); }
  }
  async remove(key: string) {
    try { await this.provider.remove(key); }
    finally { await this.invalidate(key); }
  }
}
