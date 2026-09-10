import { createHash } from "node:crypto";
import { z } from "zod";

// Stage 1 is deliberately local-only. There is no environment loader or remote adapter.
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.uuid();
const timestamp = z.iso.datetime();
const identity = z.object({ environment: z.literal("local-disposable"), provider: z.literal("fixture"),
  account: z.literal("fixture-account"), bucket: z.literal("fixture-bucket"), endpoint: z.literal("fixture://cleanup") }).strict();
const metadata = z.object({ contentType: z.string().min(1).max(256),
  custom: z.record(z.string().max(128), z.string().max(1024)) }).strict();
const item = z.object({ sourceId: id, projectId: id, field: z.enum(["storage_key", "audio_key", "thumbnail_key"]),
  key: z.string().min(1).max(1024), bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: sha, etag: z.string().min(1).max(256), headModifiedAt: timestamp, listModifiedAt: timestamp, metadata }).strict();
const schema = z.object({ version: z.literal(1), identity, operationId: id, operatorId: id, workspaceId: id,
  createdAt: timestamp, approvalExpiresAt: timestamp, backupManifestHash: sha, preservedRecordsHash: sha,
  items: z.array(item).length(6) }).strict();
export type ProtocolManifest = z.infer<typeof schema>;
export type ProtocolItem = ProtocolManifest["items"][number];
export type StorageIdentity = ProtocolManifest["identity"];
export class CleanupRefused extends Error { constructor(code: string) { super(code); this.name = "CleanupRefused"; } }
function requireFact(ok: unknown, code: string): asserts ok { if (!ok) throw new CleanupRefused(code); }
const second = (raw: string) => Math.floor(Date.parse(raw) / 1000);

/** JSON object property order is irrelevant. Array order and every string byte remain significant. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function parseProtocolManifest(input: unknown): ProtocolManifest {
  const parsed = schema.safeParse(input);
  requireFact(parsed.success, "MANIFEST_INVALID");
  const m = parsed.data;
  requireFact(Date.parse(m.approvalExpiresAt) > Date.parse(m.createdAt) &&
    Date.parse(m.approvalExpiresAt) - Date.parse(m.createdAt) <= 30 * 60_000, "APPROVAL_WINDOW_INVALID");
  requireFact(new Set(m.items.map(i => i.key)).size === 6, "DUPLICATE_KEY");
  const sources = new Map<string, ProtocolItem[]>();
  for (const i of m.items) {
    requireFact(!/[\u0000-\u001f\u007f]/.test(i.key) && !i.key.startsWith("/") &&
      !i.key.split("/").some(part => part === "." || part === ".."), "KEY_INVALID");
    requireFact(second(i.headModifiedAt) === second(i.listModifiedAt), "TIMESTAMP_MISMATCH");
    sources.set(i.sourceId, [...(sources.get(i.sourceId) ?? []), i]);
  }
  requireFact(sources.size === 2 && new Set(m.items.map(i => i.projectId)).size === 2, "SCOPE_INVALID");
  for (const items of sources.values()) requireFact(items.length === 3 && new Set(items.map(i => i.field)).size === 3 &&
    new Set(items.map(i => i.projectId)).size === 1, "SCOPE_INVALID");
  return m;
}
export function canonicalManifest(input: unknown): string { return canonical(parseProtocolManifest(input)); }
export function protocolManifestHash(input: unknown): string {
  return createHash("sha256").update(canonicalManifest(input)).digest("hex");
}

export type ObservedSource = { sourceId: string; projectId: string; workspaceId: string;
  keys: Record<ProtocolItem["field"], string | null>; referenceCount: number; activeJobs: number; blockers: string[] };
export type StoredOperation = { manifest: unknown; hash: string; state: "PREPARED" | "PENDING" | "COMPLETE" };
export type ObjectObservation = { kind: "present"; bytes: number; sha256: string; etag: string;
  modifiedAt: string; metadata: ProtocolItem["metadata"] } | { kind: "absent" } | { kind: "unknown" };
/** Implementations must authenticate the operator independently of the manifest's claimed ID. */
export interface CleanupDatabaseReader {
  readonly identity: StorageIdentity;
  inspect(operatorId: string, sourceIds: string[]): Promise<{ operatorAuthorized: boolean;
    sources: ObservedSource[]; preservedRecordsHash: string }>;
  readOperation(operationId: string): Promise<StoredOperation | null>;
}
export interface CleanupStorageReader {
  readonly identity: StorageIdentity;
  inspect(key: string): Promise<ObjectObservation>;
  verifyBackup(manifestHash: string, items: readonly ProtocolItem[]): Promise<boolean>;
}
/** Stage 2 contract only. No writer implementation or caller is supplied in Stage 1. */
export interface CleanupJournalWriter {
  reserve(manifest: ProtocolManifest, expectedHash: string): Promise<{ ownerToken: string }>;
  recordIntent(operationId: string, key: string, ownerToken: string): Promise<void>;
  // Must compare the original field and atomically commit its update, journal state, and private audit.
  commitAbsent(operationId: string, item: ProtocolItem, ownerToken: string): Promise<void>;
  complete(operationId: string, ownerToken: string): Promise<void>;
}
/** Must preserve uncertainty; it must never translate an error into confirmed absence. */
export interface CleanupObjectWriter {
  removeExact(item: ProtocolItem, ownerToken: string): Promise<"confirmed-absent" | "uncertain">;
}
export type Inspection = { hash: string; expired: boolean; state: StoredOperation["state"] | "NEW";
  objects: { key: string; observation: ObjectObservation }[]; eligibleForFutureExecution: false };

/** Read-only contract probe. Even a passing probe cannot authorize production execution. */
export async function inspectProtocolManifest(input: unknown, options: {
  mode: "inspect" | "validate-approval"; confirmation?: string; now: Date;
  resume: boolean; database: CleanupDatabaseReader; storage: CleanupStorageReader;
}): Promise<Inspection> {
  requireFact(["inspect", "validate-approval"].includes(options.mode) && typeof options.resume === "boolean", "MODE_INVALID");
  const m = parseProtocolManifest(input), hash = protocolManifestHash(m), now = options.now.getTime();
  requireFact(Number.isFinite(now) && now >= Date.parse(m.createdAt), "CLOCK_INVALID");
  const expired = now >= Date.parse(m.approvalExpiresAt);
  // Refuse stale approval and identity mismatch BEFORE calling an adapter.
  if (options.mode === "validate-approval") {
    requireFact(!expired, "APPROVAL_EXPIRED"); requireFact(options.confirmation === hash, "CONFIRMATION_MISMATCH");
  }
  requireFact(canonical(options.database.identity) === canonical(m.identity) &&
    canonical(options.storage.identity) === canonical(m.identity), "IDENTITY_MISMATCH");
  try {
    const stored = await options.database.readOperation(m.operationId);
    requireFact(options.resume ? stored !== null : stored === null, "OPERATION_MODE_MISMATCH");
    if (stored) requireFact(["PREPARED", "PENDING", "COMPLETE"].includes(stored.state) && protocolManifestHash(stored.manifest) === stored.hash && stored.hash === hash &&
      canonicalManifest(stored.manifest) === canonicalManifest(m), "IMMUTABLE_SCOPE_MISMATCH");
    const sources = [...new Set(m.items.map(i => i.sourceId))];
    const observed = await options.database.inspect(m.operatorId, sources);
    requireFact(observed.operatorAuthorized, "OPERATOR_REQUIRED");
    requireFact(observed.preservedRecordsHash === m.preservedRecordsHash, "PRESERVED_RECORDS_CHANGED");
    requireFact(observed.sources.length === 2 && new Set(observed.sources.map(s => s.sourceId)).size === 2, "SOURCE_SET_MISMATCH");
    for (const i of m.items) {
      const source = observed.sources.find(s => s.sourceId === i.sourceId);
      requireFact(source && source.projectId === i.projectId && source.workspaceId === m.workspaceId, "SOURCE_IDENTITY_MISMATCH");
      requireFact(source.activeJobs === 0 && source.blockers.length === 0 && source.referenceCount === 1, "SOURCE_BLOCKED");
      // Cleared fields can be inspected during recovery, but cannot pass the fresh approval probe.
      requireFact(source.keys[i.field] === i.key || (options.resume && options.mode === "inspect" && source.keys[i.field] === null), "KEY_REFERENCE_MISMATCH");
    }
    requireFact(await options.storage.verifyBackup(m.backupManifestHash, m.items), "BACKUP_UNVERIFIED");
    const objects: Inspection["objects"] = [];
    for (const i of m.items) {
      const o = await options.storage.inspect(i.key);
      requireFact(o.kind !== "unknown", "OBJECT_UNCERTAIN");
      if (o.kind === "present") requireFact(o.bytes === i.bytes && o.sha256 === i.sha256 && o.etag === i.etag &&
        Number.isFinite(Date.parse(o.modifiedAt)) && second(o.modifiedAt) === second(i.headModifiedAt) &&
        canonical(o.metadata) === canonical(i.metadata), "OBJECT_CHANGED");
      else requireFact(options.resume && options.mode === "inspect", "OBJECT_MISSING");
      objects.push({ key: i.key, observation: o });
    }
    return { hash, expired, state: stored?.state ?? "NEW", objects, eligibleForFutureExecution: false };
  } catch (e) { if (e instanceof CleanupRefused) throw e; throw new CleanupRefused("ADAPTER_FAILED"); }
}
