import { describe, expect, it, vi } from "vitest";
import { canonicalManifest, inspectProtocolManifest, parseProtocolManifest, protocolManifestHash,
  type CleanupDatabaseReader, type CleanupStorageReader, type ProtocolManifest, type StoredOperation } from "../scripts/lib/cleanup-protocol";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const m: ProtocolManifest = { version: 1, identity: { environment: "local-disposable", provider: "fixture",
    account: "fixture-account", bucket: "fixture-bucket", endpoint: "fixture://cleanup" },
    operationId: uuid(1), operatorId: uuid(2), workspaceId: uuid(3), createdAt: "2026-01-01T00:00:00Z",
    approvalExpiresAt: "2026-01-01T00:30:00Z", backupManifestHash: "a".repeat(64), preservedRecordsHash: "b".repeat(64),
    items: [4, 5].flatMap(n => (["storage_key", "audio_key", "thumbnail_key"] as const).map(field => ({
      sourceId: uuid(n), projectId: uuid(n + 2), field, key: `fixture/${n}/${field}-é %2F.bin`, bytes: 20,
      sha256: "c".repeat(64), etag: '"fixture-etag"', headModifiedAt: "2025-12-31T23:00:00Z",
      listModifiedAt: "2025-12-31T23:00:00.123Z", metadata: { contentType: "application/octet-stream", custom: { z: "last", a: "first" } },
    }))) };
  let stored: StoredOperation | null = null;
  const snapshot = { operatorAuthorized: true, preservedRecordsHash: m.preservedRecordsHash,
    sources: [4, 5].map(n => ({ sourceId: uuid(n), projectId: uuid(n + 2), workspaceId: m.workspaceId,
      keys: Object.fromEntries(m.items.filter(i => i.sourceId === uuid(n)).map(i => [i.field, i.key])) as Record<ProtocolManifest["items"][number]["field"], string | null>,
      activeJobs: 0, referenceCount: 1, blockers: [] as string[] })) };
  const database: CleanupDatabaseReader = { identity: m.identity, readOperation: vi.fn(async () => stored), inspect: vi.fn(async () => snapshot) };
  const storage: CleanupStorageReader = { identity: m.identity, verifyBackup: vi.fn(async () => true), inspect: vi.fn(async (key: string) => {
    const i = m.items.find(i => i.key === key)!;
    return { kind: "present" as const, bytes: i.bytes, sha256: i.sha256, etag: i.etag, modifiedAt: i.headModifiedAt, metadata: i.metadata };
  }) };
  const opts = { mode: "validate-approval" as const, confirmation: protocolManifestHash(m), now: new Date("2026-01-01T00:10:00Z"), resume: false, database, storage };
  return { m, snapshot, database, storage, opts, setStored: (s: StoredOperation) => { stored = s; } };
}
function reversedProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedProperties);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversedProperties(v)]));
  return value;
}
describe("Stage 1 cleanup protocol", () => {
  it("canonicalizes JSON properties without changing key strings or ordered arrays", () => {
    const { m } = fixture();
    expect(protocolManifestHash(reversedProperties(m))).toBe(protocolManifestHash(m));
    expect(JSON.parse(canonicalManifest(m)).items.map((i: { key: string }) => i.key)).toEqual(m.items.map(i => i.key));
    const other = structuredClone(m); other.items.reverse(); expect(protocolManifestHash(other)).not.toBe(protocolManifestHash(m));
  });
  it("performs six read-only probes and never grants execution", async () => {
    const { m, opts, storage } = fixture();
    expect(await inspectProtocolManifest(m, opts)).toMatchObject({ expired: false, state: "NEW", eligibleForFutureExecution: false });
    expect(storage.inspect).toHaveBeenCalledTimes(6);
  });
  it.each(["extra", "duplicate", "seventh", "scope", "field", "timestamp", "window", "remote", "path"])("refuses invalid %s manifests", kind => {
    const { m } = fixture(); const value = structuredClone(m);
    if (kind === "extra") Object.assign(value.items[0], { secret: "not accepted" });
    if (kind === "duplicate") value.items[1].key = value.items[0].key;
    if (kind === "seventh") value.items.push(value.items[0]);
    if (kind === "scope") value.items[0].projectId = uuid(20);
    if (kind === "field") value.items[0].field = "audio_key";
    if (kind === "timestamp") value.items[0].listModifiedAt = "2025-12-31T23:00:01.123Z";
    if (kind === "window") value.approvalExpiresAt = "2026-01-01T00:31:00Z";
    if (kind === "remote") Object.assign(value.identity, { provider: "s3", endpoint: "https://remote.invalid" });
    if (kind === "path") value.items[0].key = "../fixture";
    expect(() => parseProtocolManifest(value)).toThrow();
  });
  it.each(["expiry", "confirmation", "clock", "identity"])("refuses %s before adapter calls", async kind => {
    const f = fixture();
    if (kind === "expiry") f.opts.now = new Date(f.m.approvalExpiresAt);
    if (kind === "confirmation") f.opts.confirmation = "wrong";
    if (kind === "clock") f.opts.now = new Date("invalid");
    if (kind === "identity") Object.assign(f.database, { identity: { ...f.m.identity, bucket: "wrong" } });
    await expect(inspectProtocolManifest(f.m, f.opts)).rejects.toThrow();
    expect(f.database.readOperation).not.toHaveBeenCalled(); expect(f.storage.inspect).not.toHaveBeenCalled();
  });
  it.each(["operator", "preserved", "references", "jobs", "hold", "workspace", "key", "missing-source"])("refuses changed %s evidence", async kind => {
    const f = fixture(), s = f.snapshot;
    if (kind === "operator") s.operatorAuthorized = false;
    if (kind === "preserved") s.preservedRecordsHash = "d".repeat(64);
    if (kind === "references") s.sources[0].referenceCount = 2;
    if (kind === "jobs") s.sources[0].activeJobs = 1;
    if (kind === "hold") s.sources[0].blockers.push("hold");
    if (kind === "workspace") s.sources[0].workspaceId = uuid(20);
    if (kind === "key") s.sources[0].keys.storage_key = "wrong";
    if (kind === "missing-source") s.sources.pop();
    await expect(inspectProtocolManifest(f.m, f.opts)).rejects.toThrow(); expect(f.storage.inspect).not.toHaveBeenCalled();
  });
  it("requires backup verification before object probes", async () => {
    const f = fixture(); vi.mocked(f.storage.verifyBackup).mockResolvedValue(false);
    await expect(inspectProtocolManifest(f.m, f.opts)).rejects.toThrow("BACKUP_UNVERIFIED"); expect(f.storage.inspect).not.toHaveBeenCalled();
  });
  it.each(["absent", "unknown", "changed", "error"])("refuses %s storage results", async kind => {
    const f = fixture();
    if (kind === "error") vi.mocked(f.storage.inspect).mockRejectedValue(new Error("secret-canary"));
    else if (kind === "changed") vi.mocked(f.storage.inspect).mockResolvedValue({ kind: "present", bytes: 999,
      sha256: "c".repeat(64), etag: "changed", modifiedAt: f.m.items[0].headModifiedAt, metadata: f.m.items[0].metadata });
    else vi.mocked(f.storage.inspect).mockResolvedValue({ kind: kind as "absent" | "unknown" });
    await expect(inspectProtocolManifest(f.m, f.opts)).rejects.toThrow(kind === "error" ? "ADAPTER_FAILED" : /OBJECT_/);
  });
  it("inspects expired pending scope without authorizing more deletions", async () => {
    const f = fixture(); f.setStored({ manifest: f.m, hash: protocolManifestHash(f.m), state: "PENDING" });
    vi.mocked(f.storage.inspect).mockResolvedValue({ kind: "absent" }); f.snapshot.sources[0].keys.storage_key = null;
    const opts = { ...f.opts, mode: "inspect" as const, resume: true, now: new Date(f.m.approvalExpiresAt) };
    expect(await inspectProtocolManifest(f.m, opts)).toMatchObject({ state: "PENDING", expired: true, eligibleForFutureExecution: false });
    await expect(inspectProtocolManifest(f.m, { ...opts, mode: "validate-approval" })).rejects.toThrow("APPROVAL_EXPIRED");
  });
  it.each(["missing", "exists", "hash", "scope"])("refuses resume mismatch: %s", async kind => {
    const f = fixture();
    if (kind !== "missing") {
      const m = structuredClone(f.m); if (kind === "scope") m.operatorId = uuid(40);
      f.setStored({ manifest: m, hash: kind === "hash" ? "0".repeat(64) : protocolManifestHash(m), state: "PENDING" });
    }
    await expect(inspectProtocolManifest(f.m, { ...f.opts, resume: kind !== "exists" })).rejects.toThrow();
  });
});
