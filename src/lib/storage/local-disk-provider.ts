import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { StorageLimitExceededError, type StorageProvider } from "./types";

export class LocalDiskStorageProvider implements StorageProvider {
  constructor(private readonly root: string) {}

  absolutePath(key: string): string {
    const rootResolved = path.resolve(this.root);
    const resolved = path.resolve(rootResolved, key);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return resolved;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.absolutePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number> {
    const stats = await stat(this.absolutePath(key));
    return stats.size;
  }

  async writeFromWebStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
  ): Promise<number> {
    const target = this.absolutePath(key);
    await mkdir(path.dirname(target), { recursive: true });

    const nodeReadable = Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>);
    const fileStream = createWriteStream(target);
    let bytesWritten = 0;

    try {
      for await (const chunk of nodeReadable) {
        const buf = chunk as Buffer;
        bytesWritten += buf.length;
        if (bytesWritten > maxBytes) {
          throw new StorageLimitExceededError(`Upload exceeded ${maxBytes} byte limit.`);
        }
        if (!fileStream.write(buf)) {
          await once(fileStream, "drain");
        }
      }
      await new Promise<void>((resolve, reject) => {
        fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    } catch (error) {
      fileStream.destroy();
      await rm(target, { force: true });
      throw error;
    }

    return bytesWritten;
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(this.absolutePath(key), destinationPath);
  }

  async uploadFile(key: string, sourcePath: string): Promise<void> {
    const target = this.absolutePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(sourcePath, target);
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    const from = this.absolutePath(fromKey);
    const to = this.absolutePath(toKey);
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
  }

  async remove(key: string): Promise<void> {
    await rm(this.absolutePath(key), { force: true });
  }

  async readAsBuffer(key: string): Promise<Buffer> {
    return readFile(this.absolutePath(key));
  }
}
