import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/prepare-source-copy.ts", ...args], {
    env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 10000,
  });
}
describe("source copy CLI without credentials", () => {
  it("shows scope without a database or storage connection", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Read-only plan");
    expect(result.stdout).toContain("No automatic deletion");
  }, 15000);
  it.each([["--apply"], ["--secret-canary", "private-canary-value"], ["--confirm", "private-canary-value"]].map(args => ({ args })))
    ("refuses invalid CLI input $args without exposing values", ({ args }) => {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("private-canary-value");
  }, 15000);
});
