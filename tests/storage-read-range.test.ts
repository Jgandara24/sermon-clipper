import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDiskStorageProvider } from "@/lib/storage/local-disk-provider";

let root: string;
let storage: LocalDiskStorageProvider;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "read-range-"));
  storage = new LocalDiskStorageProvider(root);
  await writeFile(path.join(root, "ten.bin"), Buffer.from("0123456789"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalDiskStorageProvider.readRange", () => {
  it("returns the inclusive byte range asked for", async () => {
    expect((await storage.readRange("ten.bin", 2, 4)).toString()).toBe("234");
    expect((await storage.readRange("ten.bin", 0, 0)).toString()).toBe("0");
  });

  it("returns what exists when the range runs past the end, the way a 206 does", async () => {
    expect((await storage.readRange("ten.bin", 8, 100)).toString()).toBe("89");
  });

  it("is empty when the range starts past the end", async () => {
    expect((await storage.readRange("ten.bin", 10, 20)).length).toBe(0);
  });
});
