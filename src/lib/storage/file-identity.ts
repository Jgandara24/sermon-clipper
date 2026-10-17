import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";

/** Enforces the admission size during transfer, before an oversized object can fill the cache. */
export function exactByteCount(expected: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > expected ? new Error("Storage transfer exceeded its declared size.") : null, bytes <= expected ? chunk : undefined);
    },
    flush(callback) {
      callback(bytes === expected ? null : new Error("Storage transfer ended before its declared size."));
    },
  });
}

export async function fileIdentity(filePath: string): Promise<{ sha256: string; byteCount: number }> {
  const hash = createHash("sha256");
  let byteCount = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    byteCount += chunk.length;
    if (!Number.isSafeInteger(byteCount)) throw new Error("Storage object size exceeds safe precision.");
  }
  return { sha256: hash.digest("hex"), byteCount };
}
