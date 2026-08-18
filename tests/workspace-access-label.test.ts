import { describe, expect, it } from "vitest";
import { WORKSPACE_ACCESS_STATES, workspaceAccessLabel } from "@/lib/billing/access";

// The shell's billing badge used to be a nested ternary. A textual merge can silently drop one
// branch of a ternary and still typecheck, which is exactly how the "lapsed" read-only state
// could disappear from the UI while every prop still matched. The label now comes from an
// exhaustive switch, so a dropped state is a compile error, and this test proves every state
// still has its own distinct label.
describe("workspaceAccessLabel", () => {
  it("labels every access state", () => {
    expect(workspaceAccessLabel("paid")).toBe("Paid");
    expect(workspaceAccessLabel("trial_active")).toBe("Trial active");
    expect(workspaceAccessLabel("lapsed")).toBe("Subscription ended · Read-only");
    expect(workspaceAccessLabel("trial_expired")).toBe("Trial ended · Read-only");
  });

  it("never collapses a read-only state into another state's label", () => {
    const labels = WORKSPACE_ACCESS_STATES.map(workspaceAccessLabel);
    expect(new Set(labels).size).toBe(WORKSPACE_ACCESS_STATES.length);
  });
});
