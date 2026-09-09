import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readSandboxSlotArgs } from "@/lib/operations/sandbox-slot-input";

const workspace = randomUUID();
const base = ["--operator", randomUUID(), "--workspace", workspace, "--project", randomUUID(),
  "--clip", randomUUID(), "--date", "2026-09-10"];

describe("sandbox slot command input", () => {
  it("defaults to read-only", () => {
    expect(readSandboxSlotArgs(base)).toMatchObject({ apply: false, date: "2026-09-10", workspaceId: workspace });
  });
  it.each(["2026-02-30", "2026-13-01", "2026-09-10T12:00:00Z", "09/10/2026"])("refuses invalid date %s", (date) => {
    expect(() => readSandboxSlotArgs([...base.slice(0, -1), date])).toThrow();
  });
  it.each([["--apply"], ["--apply", "--confirm", "a".repeat(64)],
    ["--apply", "--confirm", "a".repeat(64), "--confirm-sandbox", randomUUID()],
    ["--confirm", "a".repeat(64)], ["--date", "2026-09-11"], ["--aplly"], ["--confirm"]])(
    "refuses ambiguous or incomplete apply options %j", (...extra) => {
      expect(() => readSandboxSlotArgs([...base, ...extra])).toThrow();
    },
  );
  it("requires both explicit confirmations to apply", () => {
    expect(readSandboxSlotArgs([...base, "--apply", "--confirm", "a".repeat(64), "--confirm-sandbox", workspace]))
      .toMatchObject({ apply: true, confirmedSandboxWorkspaceId: workspace });
  });
});
