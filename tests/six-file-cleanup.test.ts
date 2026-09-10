import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFixtureCleanup, createCleanupFixture, digest, FixtureStore, manifestHash, validateManifest, type Fault } from "../scripts/lib/six-file-cleanup";
const roots: string[] = [];
function fixture() { const s = createCleanupFixture(); roots.push(s.root); return s; }
function apply(s: FixtureStore, hook?: Parameters<typeof applyFixtureCleanup>[3]) { const m = s.manifest(); return applyFixtureCleanup(s, m, manifestHash(m), hook); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("six-file local cleanup", () => {
  it("removes exactly six files and preserves backups, evidence, transcripts, billing, and jobs", async () => {
    const s = fixture(), before = s.state(), keep = s.object("p2-keep.fixture");
    expect(await apply(s)).toMatchObject({ status: "COMPLETE", removed: 6 });
    for (const i of s.manifest().items) {
      expect(s.object(i.key)).toBeNull(); expect(digest(s.object(i.key, true)!)).toBe(i.sha256);
    }
    const after = s.state(); expect(after.protected).toEqual(before.protected);
    expect(s.object("p2-keep.fixture")).toEqual(keep);
    expect(after.sources.map(x => Object.values(x.keys))).toEqual([[null, null, null], [null, null, null]]);
    expect(after.sources.map(x => x.project)).toEqual(before.sources.map(x => x.project));
    expect(after.audit.filter(x => x.action === "REMOVED")).toHaveLength(6);
    expect(new Set(after.audit.map(x => x.id)).size).toBe(13);
    expect(after.audit.every(x => x.actor === "fixture-operator")).toBe(true);
    await expect(apply(s)).resolves.toMatchObject({ replay: true }); expect(s.state().audit).toHaveLength(13);
  });
  it.each<Fault>(["before-intent", "after-intent", "after-delete", "before-commit", "after-commit"])("recovers durable state after %s", async fault => {
    const s = fixture(), before = s.state().protected;
    await expect(apply(s, async point => { if (point === fault) throw new Error("interrupt"); })).rejects.toThrow("interrupt");
    if (["after-delete", "before-commit"].includes(fault)) {
      const key = s.manifest().items[0].key; expect(s.object(key)).toBeNull();
      expect(s.state().operation?.phases[key]).toBe("INTENT");
      expect(s.state().sources[0].keys.storage_key).toBe(key);
    }
    await expect(apply(new FixtureStore(s.root))).resolves.toMatchObject({ status: "COMPLETE" });
    expect(s.state().protected).toEqual(before); expect(s.state().audit).toHaveLength(13);
  });
  it("refuses concurrent cleanup and processing, then blocks later processing", async () => {
    const s = fixture(); let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const running = apply(s, async () => { if (first) { first = false; entered(); await gate; } });
    await ready;
    try {
      await expect(apply(new FixtureStore(s.root))).rejects.toThrow("FIXTURE_BUSY");
      await expect(s.requestProcessing("source-a")).rejects.toThrow("FIXTURE_BUSY");
    } finally { release(); await running; }
    await expect(s.requestProcessing("source-a")).rejects.toThrow("SOURCE_RETIRED");
    expect(s.state().activeJobs).toBe(0);
  });
  it.each(["active", "reference", "protected", "source", "project"])("refuses changed %s records before deletion", async kind => {
    const s = fixture(), state = s.state();
    if (kind === "active") state.activeJobs = 1;
    if (kind === "reference") state.references[s.manifest().items[5].key] = 2;
    if (kind === "protected") state.protected.transcripts[0] = "changed";
    if (kind === "source") state.sources[1].keys.thumbnail_key = "other";
    if (kind === "project") state.sources[1].project = "other";
    s.save(state); await expect(apply(s)).rejects.toThrow();
    expect(s.manifest().items.every(i => s.object(i.key) !== null)).toBe(true); expect(s.state().audit).toHaveLength(0);
  });
  it.each(["object", "missing", "backup", "missing-backup"])("preflights the last %s before deleting the first file", async kind => {
    const s = fixture(), i = s.manifest().items[5];
    if (kind === "missing") unlinkSync(path.join(s.root, s.objectName(i.key)));
    else if (kind === "missing-backup") unlinkSync(path.join(s.root, s.objectName(i.key, true)));
    else s.putFixture(i.key, Buffer.from("changed"), kind === "backup");
    await expect(apply(s)).rejects.toThrow(); expect(s.object(s.manifest().items[0].key)).not.toBeNull();
  });
  it("refuses a replaced object between preflight and deletion", async () => {
    const s = fixture();
    await expect(apply(s, async (point, key) => { if (point === "after-intent") s.putFixture(key, Buffer.from("replacement")); })).rejects.toThrow("OBJECT_CHANGED");
    expect(s.object(s.manifest().items[0].key)?.toString()).toBe("replacement");
    expect(s.state().audit.filter(x => x.action === "REMOVED")).toHaveLength(0);
  });
  it("refuses replay when a deleted object reappears", async () => {
    const s = fixture(); await apply(s); s.putFixture(s.manifest().items[0].key, Buffer.from("new"));
    await expect(apply(s)).rejects.toThrow("DELETED_OBJECT_REAPPEARED");
  });
  it.each(["../outside", "/etc/passwd", "src/production/video.mp4", "source-a/storage_key.fixture?x"])("refuses key %s", key => {
    const m = fixture().manifest(); m.items[0].key = key; expect(() => validateManifest(m)).toThrow();
  });
  it("rejects duplicate keys, wrong bucket, wrong environment, and wrong confirmation", async () => {
    const s = fixture(), m = s.manifest();
    expect(() => validateManifest({ ...m, items: [...m.items.slice(0, 5), m.items[0]] })).toThrow();
    expect(() => validateManifest({ ...m, bucket: "sermon-clipper-production" })).toThrow();
    expect(() => validateManifest({ ...m, environment: "production" })).toThrow();
    await expect(applyFixtureCleanup(s, m, "wrong")).rejects.toThrow("MANIFEST_CONFIRMATION_REQUIRED");
    const changed = { ...m, runId: "00000000-0000-4000-8000-000000000000" };
    await expect(applyFixtureCleanup(s, changed, manifestHash(changed))).rejects.toThrow("MANIFEST_CONFIRMATION_REQUIRED");
  });
  it("refuses arbitrary roots and symlink objects", async () => {
    expect(() => new FixtureStore(process.cwd())).toThrow("OWNED_FIXTURE_REQUIRED");
    const s = fixture(), i = s.manifest().items[0], target = path.join(s.root, s.objectName(i.key));
    const backup = path.join(s.root, s.objectName(i.key, true));
    unlinkSync(target); symlinkSync(backup, target);
    await expect(apply(s)).rejects.toThrow("UNSAFE_FILE"); expect(readFileSync(backup).length).toBe(i.bytes);
  });
  it("exercises the command in a clean child process with a persisted interruption", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/cleanup-six-files.ts", "--fixture", "--interrupt", "before-commit"], {
      encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    });
    const result = JSON.parse(output); roots.push(result.root);
    expect(result.interrupted).toBe(true); expect(result.status).toBe("COMPLETE"); expect(result.replay.replay).toBe(true);
  });
  it.each(["intent-write", "record-write", "lost-record-response", "delete-failure"])("recovers a failed %s boundary", async failure => {
    const s = fixture(), original = s.save.bind(s), key = s.manifest().items[0].key;
    let failed = false;
    const save = vi.spyOn(s, "save").mockImplementation(state => {
      const phase = state.operation?.phases[key];
      const fail = !failed && ((failure === "intent-write" && phase === "INTENT") ||
        (["record-write", "lost-record-response"].includes(failure) && phase === "DONE"));
      if (fail) {
        failed = true;
        if (failure === "lost-record-response") original(state);
        throw new Error("state write failed");
      }
      original(state);
    });
    const remove = failure === "delete-failure" ? vi.spyOn(s, "remove").mockImplementationOnce(() => { throw new Error("delete failed"); }) : undefined;
    try { await expect(apply(s)).rejects.toThrow("failed"); }
    finally { save.mockRestore(); remove?.mockRestore(); }
    if (failure === "intent-write" || failure === "delete-failure") expect(s.object(key)).not.toBeNull();
    if (failure === "record-write") {
      expect(s.object(key)).toBeNull(); expect(s.state().operation?.phases[key]).toBe("INTENT");
      expect(s.state().sources[0].keys.storage_key).toBe(key);
    }
    await expect(apply(new FixtureStore(s.root))).resolves.toMatchObject({ status: "COMPLETE" });
    expect(s.state().audit).toHaveLength(13);
  });
  it("recovers after three files were committed without duplicate audit records", async () => {
    const s = fixture(), fourth = s.manifest().items[3].key;
    await expect(apply(s, async (point, key) => { if (point === "after-delete" && key === fourth) throw new Error("interrupt"); })).rejects.toThrow();
    expect(s.state().audit.filter(x => x.action === "REMOVED")).toHaveLength(3);
    await apply(new FixtureStore(s.root)); expect(s.state().audit).toHaveLength(13);
  });
  it("refuses a surviving lock without removing it", async () => {
    const s = fixture(); mkdirSync(path.join(s.root, "operation.lock"));
    await expect(apply(s)).rejects.toThrow("FIXTURE_BUSY");
    expect(s.manifest().items.every(i => s.object(i.key) !== null)).toBe(true);
  });
  it("rejects a premature completion flag", async () => {
    const s = fixture(), state = s.state();
    state.operation = { manifestHash: manifestHash(s.manifest()), phases: {}, complete: true };
    s.save(state);
    await expect(apply(s)).rejects.toThrow();
    expect(s.manifest().items.every(i => s.object(i.key) !== null)).toBe(true);
  });
  it.each(["audit", "retirement"])("rejects damaged completed %s evidence", async kind => {
    const s = fixture(); await apply(s); const state = s.state();
    if (kind === "audit") state.audit.pop(); else state.retired = [];
    s.save(state); await expect(apply(s)).rejects.toThrow();
  });
  it.each(["backup", "reference"])("rechecks %s after saved intent and before deletion", async kind => {
    const s = fixture(), key = s.manifest().items[0].key;
    await expect(apply(s, async point => {
      if (point !== "after-intent") return;
      if (kind === "backup") s.putFixture(key, Buffer.from("damaged"), true);
      else { const state = s.state(); state.references[key] = 2; s.save(state); }
    })).rejects.toThrow();
    expect(s.object(key)).not.toBeNull();
  });
  it("does not overwrite records changed during a failed commit", async () => {
    const s = fixture();
    await expect(apply(s, async point => {
      if (point !== "before-commit") return;
      const state = s.state(); state.protected.billing.push("new charge"); s.save(state);
    })).rejects.toThrow();
    expect(s.state().protected.billing).toContain("new charge");
  });
  it.each([["--apply"], ["--fixture", "--root", "/tmp"], []])("refuses CLI arguments %j", (...args) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/cleanup-six-files.ts", ...args], { encoding: "utf8" });
    expect(result.status).toBe(1); expect(result.stderr).toContain("Cleanup refused");
  });
  it("refuses ambient connection settings without leaking their values", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/cleanup-six-files.ts", "--fixture"], {
      encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: "secret-canary" },
    });
    expect(result.status).toBe(1); expect(result.stderr).not.toContain("secret-canary");
  });
});
