import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readSandboxServiceArgs } from "@/lib/operations/sandbox-service-input";

const ids = { operator: randomUUID(), importer: randomUUID(), workspace: randomUUID(), source: randomUUID() };
const base = ["--operator", ids.operator, "--import-user", ids.importer, "--workspace", ids.workspace,
  "--source-video", ids.source, "--name", "P2 copied-source service", "--date", "2026-05-20",
  "--occurrence", "UNMATCHED"];

describe("sandbox service command input", () => {
  it("is read-only by default", () => {
    expect(readSandboxServiceArgs(base)).toMatchObject({ apply: false, queueFinalize: false });
  });

  it("requires every exact apply confirmation", () => {
    expect(() => readSandboxServiceArgs([...base, "--apply"])).toThrow("exact apply confirmation");
    expect(() => readSandboxServiceArgs([...base, "--apply", "--queue-finalize",
      "--plan", "/tmp/approved.json", "--confirm", "a".repeat(64),
      "--confirm-sandbox", ids.workspace])).not.toThrow();
  });

  it("refuses confirmation options in read-only mode", () => {
    expect(() => readSandboxServiceArgs([...base, "--queue-finalize"])).toThrow("require --apply");
  });
});
