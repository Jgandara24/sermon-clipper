import { describe, expect, it } from "vitest";
import {
  assertWorkspaceScope,
  buildDefaultProcessingConfig,
  buildDraftProjectRecord,
  normalizeProjectName,
} from "@/lib/project-service";

describe("workspace scoping", () => {
  it("allows records that belong to the current workspace", () => {
    expect(() => assertWorkspaceScope("workspace-a", "workspace-a", "project")).not.toThrow();
  });

  it("rejects records from another workspace", () => {
    expect(() => assertWorkspaceScope("workspace-a", "workspace-b", "project")).toThrow(
      "Workspace access denied for project.",
    );
  });
});

describe("draft project creation data", () => {
  it("normalizes project names and builds a draft record", () => {
    const record = buildDraftProjectRecord("workspace-a", {
      name: "  Sunday   Morning  ",
      sourceUrl: "https://example.com/video.mp4",
      series: "Foundation",
      speaker: "Pastor Demo",
    });

    expect(record).toMatchObject({
      workspaceId: "workspace-a",
      name: "Sunday Morning",
      status: "DRAFT",
      series: "Foundation",
      speaker: "Pastor Demo",
      processingConfig: buildDefaultProcessingConfig(),
    });
  });

  it("rejects blank project names", () => {
    expect(() => normalizeProjectName(" ")).toThrow("Project name must be at least 2 characters.");
  });
});
