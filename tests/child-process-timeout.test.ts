import { afterEach, describe, expect, it } from "vitest";
import {
  ChildProcessTimeoutError,
  envTimeoutMs,
  execFileWithTimeout,
} from "@/lib/media/child-process";

describe("execFileWithTimeout", () => {
  it("kills a process that exceeds the timeout and throws ChildProcessTimeoutError", async () => {
    await expect(
      execFileWithTimeout("sleep", ["5"], { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(ChildProcessTimeoutError);
  });

  it("returns stdout for a process that finishes in time", async () => {
    const { stdout } = await execFileWithTimeout("echo", ["ok"], { timeoutMs: 5_000 });
    expect(stdout.trim()).toBe("ok");
  });

  it("propagates ordinary failures without rebranding them as timeouts", async () => {
    await expect(
      execFileWithTimeout("false", [], { timeoutMs: 5_000 }),
    ).rejects.not.toBeInstanceOf(ChildProcessTimeoutError);
  });
});

describe("envTimeoutMs", () => {
  afterEach(() => {
    delete process.env.CHILD_PROCESS_TIMEOUT_TEST;
  });

  it("uses the default when the env var is unset", () => {
    expect(envTimeoutMs("CHILD_PROCESS_TIMEOUT_TEST", 1234)).toBe(1234);
  });

  it("uses the env value when it is a positive number", () => {
    process.env.CHILD_PROCESS_TIMEOUT_TEST = "60000";
    expect(envTimeoutMs("CHILD_PROCESS_TIMEOUT_TEST", 1234)).toBe(60000);
  });

  it("falls back to the default for non-numeric or non-positive values", () => {
    process.env.CHILD_PROCESS_TIMEOUT_TEST = "not-a-number";
    expect(envTimeoutMs("CHILD_PROCESS_TIMEOUT_TEST", 1234)).toBe(1234);
    process.env.CHILD_PROCESS_TIMEOUT_TEST = "0";
    expect(envTimeoutMs("CHILD_PROCESS_TIMEOUT_TEST", 1234)).toBe(1234);
  });
});
