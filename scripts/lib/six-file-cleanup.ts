import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

const fields = ["storage_key", "audio_key", "thumbnail_key"] as const;
type Field = typeof fields[number];
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const itemSchema = z.object({ source: z.enum(["source-a", "source-b"]), field: z.enum(fields),
  key: z.string(), bytes: z.number().int().positive().max(4096), sha256: hash }).strict();
const manifestSchema = z.object({ version: z.literal(1), environment: z.literal("local-disposable"),
  bucket: z.literal("six-file-fixture"), runId: z.uuid(), actor: z.literal("fixture-operator"),
  protectedHash: hash, items: z.array(itemSchema).length(6) }).strict();
export type CleanupManifest = z.infer<typeof manifestSchema>;
type Item = CleanupManifest["items"][number];
type Source = { id: string; project: string; keys: Record<Field, string | null>; updatedAt: string };
type Audit = { id: string; actor: string; action: "INTENT" | "REMOVED" | "COMPLETE"; key?: string; at: string; manifestHash: string };
export type FixtureState = {
  runId: string; sources: Source[];
  protected: { transcripts: string[]; segments: string[]; billing: string[]; jobs: string[]; evidence: string[] };
  references: Record<string, number>; activeJobs: number; retired: string[];
  operation: null | { manifestHash: string; phases: Record<string, "INTENT" | "DONE">; complete: boolean };
  audit: Audit[];
};
export type Fault = "before-intent" | "after-intent" | "after-delete" | "before-commit" | "after-commit";
function refuse(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
export function validateManifest(input: unknown): CleanupManifest {
  const m = manifestSchema.parse(input);
  const expected = ["source-a", "source-b"].flatMap(source => fields.map(field => `${source}/${field}.fixture`));
  refuse(new Set(m.items.map(i => i.key)).size === 6, "DUPLICATE_KEY");
  for (const i of m.items) refuse(i.key === `${i.source}/${i.field}.fixture` && expected.includes(i.key), "EXACT_KEY_REQUIRED");
  return m;
}
export function manifestHash(m: CleanupManifest) { return digest(JSON.stringify(validateManifest(m))); }

/** No remote adapter exists. The constructor requires a capability issued for a new owned directory. */
const ownedRoots = new Map<string, string>();
const stateVersions = new WeakMap<FixtureState, string>();
export class FixtureStore {
  constructor(readonly root: string) {
    refuse(ownedRoots.has(root) && realpathSync(root) === root && !lstatSync(root).isSymbolicLink(), "OWNED_FIXTURE_REQUIRED");
  }
  private file(name: string) {
    refuse(/^[a-z0-9.-]+$/.test(name), "LOCAL_FILENAME_REQUIRED");
    refuse(!lstatSync(this.root).isSymbolicLink() && realpathSync(this.root) === this.root, "ROOT_CHANGED");
    const file = path.join(this.root, name);
    if (existsSync(file)) refuse(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && lstatSync(file).nlink === 1, "UNSAFE_FILE");
    return file;
  }
  private read(name: string) {
    const fd = openSync(this.file(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return readFileSync(fd); } finally { closeSync(fd); }
  }
  private syncDirectory() {
    const fd = openSync(this.root, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private atomic(name: string, bytes: string | Buffer) {
    const destination = this.file(name), temporary = this.file(`${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, destination); this.syncDirectory();
  }
  state(): FixtureState {
    const bytes = this.read("state.json");
    const s = JSON.parse(bytes.toString()) as FixtureState;
    refuse(s.runId === ownedRoots.get(this.root), "FIXTURE_ID_CHANGED");
    stateVersions.set(s, digest(bytes)); return s;
  }
  save(state: FixtureState) {
    refuse(state.runId === ownedRoots.get(this.root), "FIXTURE_ID_CHANGED");
    const expected = stateVersions.get(state);
    if (existsSync(this.file("state.json"))) refuse(expected === digest(this.read("state.json")), "STATE_CHANGED");
    else refuse(expected === undefined, "STATE_MISSING");
    const bytes = JSON.stringify(state);
    this.atomic("state.json", bytes); stateVersions.set(state, digest(bytes));
  }
  manifest(): CleanupManifest { return validateManifest(JSON.parse(this.read("manifest.json").toString())); }
  objectName(key: string, backup = false) { return `${backup ? "backup" : "object"}-${digest(key)}.bin`; }
  object(key: string, backup = false): Buffer | null {
    const name = this.objectName(key, backup);
    // lstat also detects dangling symlinks; do not treat them as absent objects.
    try { lstatSync(path.join(this.root, name)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    return this.read(name);
  }
  putFixture(key: string, bytes: Buffer, backup = false) { this.atomic(this.objectName(key, backup), bytes); }
  remove(item: Item) {
    const bytes = this.object(item.key);
    refuse(bytes && digest(bytes) === item.sha256 && bytes.length === item.bytes, "OBJECT_CHANGED");
    unlinkSync(this.file(this.objectName(item.key))); this.syncDirectory();
  }
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const lock = path.join(this.root, "operation.lock");
    // No timeout, stale-lock takeover, or forced unlock. A crashed owner requires manual review.
    try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error("FIXTURE_BUSY"); }
    try { return await work(); } finally { rmdirSync(lock); }
  }
  async requestProcessing(source: string) {
    return this.exclusive(async () => {
      const s = this.state(); refuse(!s.retired.includes(source), "SOURCE_RETIRED");
      s.activeJobs++; this.save(s);
    });
  }
}

export function createCleanupFixture(): FixtureStore {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "six-file-cleanup-")));
  const runId = randomUUID(); ownedRoots.set(root, runId);
  const store = new FixtureStore(root);
  const state: FixtureState = { runId, sources: [], protected: {
    transcripts: ["Synthetic transcript A", "Synthetic transcript B"], segments: ["Synthetic segment A", "Synthetic segment B"],
    billing: ["fixture charge A", "fixture charge B"], jobs: ["failed job A", "failed job B"], evidence: ["P2 keep A", "P3 keep B"],
  }, references: {}, activeJobs: 0, retired: [], operation: null, audit: [] };
  const items: Item[] = [];
  for (const source of ["source-a", "source-b"] as const) {
    const keys = {} as Record<Field, string>;
    for (const field of fields) {
      const key = `${source}/${field}.fixture`, bytes = Buffer.from(`DISPOSABLE SYNTHETIC MEDIA ${key}`);
      keys[field] = key; state.references[key] = 1;
      store.putFixture(key, bytes); store.putFixture(key, bytes, true);
      items.push({ source, field, key, bytes: bytes.length, sha256: digest(bytes) });
    }
    state.sources.push({ id: source, project: `project-${source}`, keys, updatedAt: "fixture-baseline" });
  }
  store.putFixture("p2-keep.fixture", Buffer.from("P2 evidence: preserve this object"));
  store.save(state);
  const manifest: CleanupManifest = { version: 1, environment: "local-disposable", bucket: "six-file-fixture", runId,
    actor: "fixture-operator", protectedHash: digest(JSON.stringify(state.protected)), items };
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
  return store;
}

function verifyCleanupState(store: FixtureStore, m: CleanupManifest, mh: string, s: FixtureState) {
  const keys = new Set(m.items.map(i => i.key));
  const phases = s.operation?.phases ?? {};
  refuse(Object.keys(phases).every(key => keys.has(key) && ["INTENT", "DONE"].includes(phases[key])), "JOURNAL_CHANGED");
  const expectedEvents = new Map<string, { action: Audit["action"]; key?: string }>();
  for (const [key, phase] of Object.entries(phases)) {
    expectedEvents.set(`${mh}:${key}:INTENT`, { action: "INTENT", key });
    if (phase === "DONE") expectedEvents.set(`${mh}:${key}:REMOVED`, { action: "REMOVED", key });
  }
  if (s.operation?.complete) {
    refuse(m.items.every(i => phases[i.key] === "DONE"), "INCOMPLETE_JOURNAL");
    expectedEvents.set(`${mh}:operation:COMPLETE`, { action: "COMPLETE" });
  }
  refuse(s.audit.length === expectedEvents.size && new Set(s.audit.map(a => a.id)).size === expectedEvents.size, "AUDIT_CHANGED");
  for (const a of s.audit) {
    const expected = expectedEvents.get(a.id);
    refuse(expected && a.action === expected.action && a.key === expected.key && a.actor === m.actor &&
      a.manifestHash === mh && Number.isFinite(Date.parse(a.at)), "AUDIT_CHANGED");
  }
  if (s.operation) refuse(s.retired.length === 2 && ["source-a", "source-b"].every(id => s.retired.includes(id)), "RETIREMENT_CHANGED");
  refuse(s.runId === m.runId && (!s.operation || s.operation.manifestHash === mh), "OPERATION_MISMATCH");
  refuse(s.activeJobs === 0, "ACTIVE_JOBS");
  refuse(digest(JSON.stringify(s.protected)) === m.protectedHash, "PROTECTED_RECORDS_CHANGED");
  refuse(s.sources.length === 2 && new Set(s.sources.map(x => x.id)).size === 2, "SOURCE_SET_CHANGED");
  // Preflight the ENTIRE scope before any destructive operation, including during recovery.
  for (const i of m.items) {
    const source = s.sources.find(x => x.id === i.source), phase = s.operation?.phases[i.key];
    refuse(source?.project === `project-${i.source}` && source.keys[i.field] === (phase === "DONE" ? null : i.key), "REFERENCE_CHANGED");
    refuse(s.references[i.key] === (phase === "DONE" ? 0 : 1), "REFERENCE_CHANGED");
    const backup = store.object(i.key, true), object = store.object(i.key);
    refuse(backup && backup.length === i.bytes && digest(backup) === i.sha256, "BACKUP_NOT_VERIFIED");
    if (phase === "DONE") refuse(!object, "DELETED_OBJECT_REAPPEARED");
    else if (object) refuse(object.length === i.bytes && digest(object) === i.sha256, "OBJECT_CHANGED");
    else refuse(phase === "INTENT", "UNEXPLAINED_MISSING_OBJECT");
  }
}

/** Intent is durable BEFORE unlink. A guarded state write commits the key update and audit together. */
export async function applyFixtureCleanup(store: FixtureStore, input: unknown, confirmation: string,
  checkpoint: (fault: Fault, key: string) => Promise<void> = async () => {}) {
  const m = validateManifest(input), mh = manifestHash(m);
  refuse(confirmation === mh && manifestHash(store.manifest()) === mh, "MANIFEST_CONFIRMATION_REQUIRED");
  return store.exclusive(async () => {
    let s = store.state();
    verifyCleanupState(store, m, mh, s);
    const audit = (action: Audit["action"], key?: string): Audit => ({ id: `${mh}:${key ?? "operation"}:${action}`,
      actor: m.actor, action, key, at: new Date().toISOString(), manifestHash: mh });
    if (s.operation?.complete) return { status: "COMPLETE", removed: 6, replay: true };
    s.operation ??= { manifestHash: mh, phases: {}, complete: false };
    // This local retirement is honored by the local processing entry point and the same lock.
    // It does NOT claim to block production workers.
    s.retired = ["source-a", "source-b"];
    store.save(s);
    for (const i of m.items) {
      if (s.operation!.phases[i.key] === "DONE") continue;
      await checkpoint("before-intent", i.key);
      if (!s.operation!.phases[i.key]) {
        s.operation!.phases[i.key] = "INTENT"; s.audit.push(audit("INTENT", i.key)); store.save(s);
      }
      await checkpoint("after-intent", i.key);
      s = store.state();
      verifyCleanupState(store, m, mh, s);
      if (store.object(i.key)) store.remove(i);
      await checkpoint("after-delete", i.key);
      // Read again: failure before commit leaves the durable INTENT for a later instance.
      s = store.state();
      verifyCleanupState(store, m, mh, s);
      refuse(s.operation?.manifestHash === mh && s.operation.phases[i.key] === "INTENT", "JOURNAL_CHANGED");
      refuse(digest(JSON.stringify(s.protected)) === m.protectedHash, "PROTECTED_RECORDS_CHANGED");
      const source = s.sources.find(x => x.id === i.source)!;
      refuse(source.keys[i.field] === i.key && s.references[i.key] === 1, "REFERENCE_CHANGED");
      source.keys[i.field] = null; source.updatedAt = new Date().toISOString(); s.references[i.key] = 0;
      s.operation.phases[i.key] = "DONE"; s.audit.push(audit("REMOVED", i.key));
      await checkpoint("before-commit", i.key); store.save(s);
      await checkpoint("after-commit", i.key);
    }
    s.operation!.complete = true; s.audit.push(audit("COMPLETE")); store.save(s);
    return { status: "COMPLETE", removed: 6, replay: false };
  });
}
