import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { storageContract, StorageBudget } from "../scripts/lib/rehearsal-storage-contract";
import { sha256 } from "../scripts/lib/release-rehearsal";

describe("disposable storage contract", () => {
  it("checks conditional copies against owned disk objects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p2-storage-contract-"));
    const objects = new Map<string, { file: string; owner: string | null }>();
    try {
      const result = await storageContract({
        async putOwned(key, bytes) {
          const existing = objects.get(key);
          const file = existing?.file ?? path.join(root, sha256(key));
          await writeFile(file, bytes, { flag: existing ? "w" : "wx" });
          objects.set(key, { file, owner: null });
        },
        storage: {
          identity: "owned-disk-fixture",
          async inspect(key, maxBytes) {
            const object = objects.get(key); if (!object) return null;
            const bytes = await readFile(object.file);
            if (bytes.length > maxBytes) throw new Error("Too large.");
            return { bytes: bytes.length, sha256: sha256(bytes), etag: sha256(bytes), owner: object.owner, versionId: null, lastModified: null };
          },
          async copy(source, destination, etag, owner) {
            const object = objects.get(source); if (!object) throw new Error("Missing source.");
            const bytes = await readFile(object.file);
            if (sha256(bytes) !== etag) throw new Error("Source changed.");
            const file = path.join(root, sha256(destination));
            await writeFile(file, bytes, { flag: "wx" }); // Kernel create-exclusively enforces concurrency.
            objects.set(destination, { file, owner });
          },
        },
      });
      expect(result.status).toBe("PASS");
      expect(objects.size).toBe(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps cleanup capacity and refuses unapproved costs", () => {
    expect(() => new StorageBudget(0, 0)).toThrow();
    expect(() => new StorageBudget(1, 2)).toThrow();
    const budget = new StorageBudget(1, 0.1);
    for (let index = 0; index < 88; index++) budget.request();
    expect(() => budget.request()).toThrow();
    for (let index = 0; index < 12; index++) budget.request(true);
    expect(() => budget.request(true)).toThrow();
    budget.write(32 * 1024 * 1024);
    expect(() => budget.write(1)).toThrow();
  });
});
