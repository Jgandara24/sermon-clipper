import { describe, expect, it } from "vitest";
import {
  assertWorkspaceScope,
  buildDefaultProcessingConfig,
  buildDraftProjectRecord,
  normalizeProjectName,
  readProjectProcessingConfig,
} from "@/lib/project-service";
import type { ChurchProfile } from "@/lib/church-profile";

const onceWeeklyProfile: ChurchProfile = {
  timezone: "America/Chicago",
  serviceDay: "Sunday",
  sermonsPerWeek: 1,
  secondServiceDay: null,
  postsPerDay: 1,
};

const twiceWeeklyProfile: ChurchProfile = {
  ...onceWeeklyProfile,
  sermonsPerWeek: 2,
  secondServiceDay: "Wednesday",
};

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

  it("targets 6 clips for a once-a-week church by default", () => {
    expect(buildDefaultProcessingConfig()).toMatchObject({ targetClipCount: 6 });
  });

  it("snapshots one-service candidate and schedule configuration", () => {
    expect(buildDefaultProcessingConfig(onceWeeklyProfile, "PRIMARY")).toMatchObject({
      configurationVersion: 1,
      candidateLimit: 18,
      targetClipCount: 6,
      timezone: "America/Chicago",
      serviceDay: "Sunday",
      secondServiceDay: null,
      sermonsPerWeek: 1,
      serviceOccurrence: "PRIMARY",
    });
  });

  it("snapshots a valid hidden candidate limit override", () => {
    expect(buildDefaultProcessingConfig(onceWeeklyProfile, "PRIMARY", 12)).toMatchObject({
      candidateLimit: 12,
      targetClipCount: 6,
    });
  });

  it("does not snapshot a candidate limit below the scheduled count", () => {
    expect(buildDefaultProcessingConfig(onceWeeklyProfile, "PRIMARY", 3)).toMatchObject({
      candidateLimit: 6,
      targetClipCount: 6,
    });
  });

  it("targets 3 clips for a twice-a-week church", () => {
    expect(buildDefaultProcessingConfig(twiceWeeklyProfile, "SECONDARY")).toMatchObject({
      targetClipCount: 3,
      serviceOccurrence: "SECONDARY",
    });

    const record = buildDraftProjectRecord(
      "workspace-a",
      { name: "Wednesday Night" },
      undefined,
      twiceWeeklyProfile,
    );
    expect(record.processingConfig).toMatchObject({ targetClipCount: 3 });
  });

  it("reads legacy project configuration with current defaults", () => {
    expect(readProjectProcessingConfig({ genre: "teaching", targetClipCount: 3 })).toMatchObject({
      genre: "teaching",
      configurationVersion: 1,
      candidateLimit: 18,
      targetClipCount: 3,
      timezone: "America/Chicago",
      serviceDay: "Sunday",
      secondServiceDay: null,
      sermonsPerWeek: 1,
      serviceOccurrence: "PRIMARY",
    });
  });
});
