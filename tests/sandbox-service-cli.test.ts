import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/prepare-sandbox-service.ts", ...args], {
    env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 10000,
  });
}

describe("sandbox service CLI without credentials", () => {
  it("shows its read-only default and worker boundary without connecting", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Read-only by default");
    expect(result.stdout).toContain("does not start a worker");
  });

  it("refuses invalid input without exposing supplied values", () => {
    const result = run(["--apply", "--confirm", "private-canary-value"]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("private-canary-value");
  });
});
