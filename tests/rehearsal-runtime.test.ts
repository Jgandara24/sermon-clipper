import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalRuntime, networkProfile, OwnedProcess } from "../scripts/lib/rehearsal-runtime";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("local rehearsal runtime", () => {
  it.each([[], [0], [80], [65536], [1.5], [Number.NaN]])("refuses invalid runtime ports", (...ports) => {
    expect(() => networkProfile(ports)).toThrow();
  });
  it("limits network access to named local ports", () => {
    const profile = networkProfile([15432, 15433]);
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('remote ip "localhost:15432"');
    expect(profile).not.toContain("localhost:*");
  });
  it.runIf(process.platform === "darwin")("refuses startup before OS proof and inherited environment overrides", () => {
    const root = mkdtempSync(path.join(tmpdir(), "p2-runtime-test-")); roots.push(root);
    const runtime = new LocalRuntime(root, [15432]);
    expect(() => runtime.start(process.execPath, ["-e", "process.exit(0)"])).toThrow("Verify OS");
    expect(() => runtime.environment({ NODE_OPTIONS: "secret-canary" })).toThrow("override refused");
    expect(() => runtime.environment({ DATABASE_URL: "postgresql://p2_fixture@remote.invalid:15432/p2_rehearsal_" + "a".repeat(32) + "?schema=public" })).toThrow();
    expect(() => runtime.environment({ DATABASE_URL: "postgresql://p2_fixture@127.0.0.1:15434/p2_rehearsal_" + "a".repeat(32) + "?schema=public" })).toThrow("port");
    expect(() => runtime.environment({ REHEARSAL_CONTROL: "/outside" })).toThrow("not owned");
    expect(runtime.environment().LC_ALL).toBe("C");
  });
  it("waits for an owned process exit and records its result", async () => {
    const child = new OwnedProcess(process.execPath, ["-e", "console.log('fixture only')"], tmpdir(), { NODE_ENV: "test" });
    const result = await child.wait(5000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("fixture only");
    expect(child.parentPid).toBe(process.pid);
    child.signal("SIGKILL"); // Terminal process is never signaled again.
  });
  it("enforces the deadline and then stops its owned process group", async () => {
    const child = new OwnedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], tmpdir(), { NODE_ENV: "test" });
    try { await expect(child.wait(20)).rejects.toThrow("deadline"); }
    finally { await child.stop(200); }
    expect(child.result?.signal).toBe("SIGTERM");
  });
});
