import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDiskStorageProvider } from "@/lib/storage/local-disk-provider";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "sermon-storage-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("LocalDiskStorageProvider file bridge", () => {
  it("downloads stored objects to caller-owned temp files", async () => {
    const storage = new LocalDiskStorageProvider(path.join(tmpDir, "storage"));
    await storage.writeFromWebStream(
      "src/workspace-1/source.txt",
      new Blob(["source body"]).stream(),
      1024,
    );

    const destination = path.join(tmpDir, "worker", "source.txt");
    await storage.downloadToFile("src/workspace-1/source.txt", destination);

    expect(await readFile(destination, "utf-8")).toBe("source body");
  });

  it("uploads caller-owned temp files back into storage", async () => {
    const storage = new LocalDiskStorageProvider(path.join(tmpDir, "storage"));
    const source = path.join(tmpDir, "worker", "output.txt");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "rendered body");

    await storage.uploadFile("exports/workspace-1/output.txt", source);

    expect(await storage.readAsBuffer("exports/workspace-1/output.txt")).toEqual(
      Buffer.from("rendered body"),
    );
  });
});
