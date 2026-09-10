import { randomUUID } from "node:crypto";
import { type CopyStorage } from "../../src/lib/operations/source-copy";

export type DisposableObjects = {
  storage: CopyStorage;
  /** Must create only a new owned key, or replace an exact key created by this instance. */
  putOwned: (key: string, bytes: Buffer) => Promise<void>;
};

/** The same bounded assertions can use a disk fixture or an explicitly approved remote bucket. */
export async function storageContract({ storage, putOwned }: DisposableObjects) {
  const runId = randomUUID();
  const key = (name: string) => `p2-rehearsal/${runId}/${name}`;
  const source = key("source.bin"), destination = key("copy.bin"), race = key("race.bin"), changed = key("changed.bin");
  const original = Buffer.from("Synthetic storage contract A");
  const replacement = Buffer.from("Synthetic storage contract B");
  await putOwned(source, original);
  const inspected = await storage.inspect(source, 1024);
  if (!inspected || inspected.bytes !== original.length) throw new Error("Fixture inspection failed.");
  await storage.copy(source, destination, inspected.etag, runId);
  const copied = await storage.inspect(destination, 1024);
  if (!copied || copied.sha256 !== inspected.sha256 || copied.owner !== runId) throw new Error("Copy identity differs.");
  let destinationRefused = false;
  try { await storage.copy(source, destination, inspected.etag, runId); } catch { destinationRefused = true; }
  if (!destinationRefused || (await storage.inspect(destination, 1024))?.sha256 !== copied.sha256) throw new Error("Existing destination was not protected.");
  const concurrent = await Promise.allSettled([
    storage.copy(source, race, inspected.etag, runId), storage.copy(source, race, inspected.etag, runId),
  ]);
  if (concurrent.filter(result => result.status === "fulfilled").length !== 1) throw new Error("Concurrent conditional copies did not have exactly one winner.");
  if ((await storage.inspect(race, 1024))?.sha256 !== inspected.sha256) throw new Error("Concurrent copy bytes differ.");
  await putOwned(source, replacement);
  let sourceRefused = false;
  try { await storage.copy(source, changed, inspected.etag, runId); } catch { sourceRefused = true; }
  if (!sourceRefused || await storage.inspect(changed, 1024) !== null) throw new Error("Changed source was copied.");
  let sizeRefused = false;
  try { await storage.inspect(source, 1); } catch { sizeRefused = true; }
  if (!sizeRefused) throw new Error("Fixture size bound was ignored.");
  return { runId, keys: [source, destination, race, changed], destinationRefused, sourceRefused, sizeRefused,
    concurrentWinners: 1, originalSha256: inspected.sha256, status: "PASS",
    limits: ["Storage conditions only. Registration and lost-response recovery are tested separately with the application and local database."] };
}

export class StorageBudget {
  requests = 0;
  bytesWritten = 0;
  readonly startedAt = Date.now();
  constructor(readonly maxUsd: number, readonly worstCaseUsd: number) {
    if (!Number.isFinite(maxUsd) || maxUsd <= 0 || !Number.isFinite(worstCaseUsd) || worstCaseUsd < 0 || worstCaseUsd > maxUsd) throw new Error("Approved storage cost limit is missing or insufficient.");
  }
  request(cleanup = false) {
    // Reserve twelve requests for exact-key cleanup. No retry hidden inside this ledger.
    if (Date.now() - this.startedAt > 15 * 60000 || this.requests >= (cleanup ? 100 : 88)) throw new Error("Storage request or time limit reached.");
    this.requests++;
  }
  write(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.bytesWritten + bytes > 32 * 1024 * 1024) throw new Error("Storage byte limit reached.");
    this.bytesWritten += bytes;
  }
}
