import { describe, expect, it, vi } from "vitest";
import {
  REANALYSIS_BLOCKED,
  assertReanalysisAllowed,
  assessReanalysis,
  countDurableWork,
  hasDurableWork,
  reanalysisBlockedError,
} from "@/lib/analysis/reanalysis-policy";
import { JobFailureError } from "@/lib/jobs/types";

/**
 * A client whose counts are set per test. `clipEdit.count` answers the total on the first call
 * and the system-initial count on the second, which is the order the policy asks in.
 */
function fakeClient(counts: {
  edits?: number;
  systemEdits?: number;
  approvals?: number;
  exports?: number;
  posts?: number;
}) {
  const clipEditCount = vi
    .fn()
    .mockResolvedValueOnce((counts.edits ?? 0) + (counts.systemEdits ?? 0))
    .mockResolvedValueOnce(counts.systemEdits ?? 0);
  return {
    clipEdit: { count: clipEditCount },
    clipApproval: { count: vi.fn().mockResolvedValue(counts.approvals ?? 0) },
    exportJob: { count: vi.fn().mockResolvedValue(counts.exports ?? 0) },
    scheduledPost: { count: vi.fn().mockResolvedValue(counts.posts ?? 0) },
  };
}

describe("countDurableWork", () => {
  it("counts a person's edits, approvals, exports and delivered posts", async () => {
    const client = fakeClient({ edits: 2, systemEdits: 3, approvals: 1, exports: 4, posts: 1 });
    await expect(countDurableWork(client as never, { projectId: "p" })).resolves.toEqual({
      edits: 2,
      approvals: 1,
      exports: 4,
      posts: 1,
    });
  });

  it("does not count the machine's initial documents as edits", async () => {
    const client = fakeClient({ edits: 0, systemEdits: 6 });
    await expect(countDurableWork(client as never, { projectId: "p" })).resolves.toMatchObject({ edits: 0 });
  });

  it("asks for the machine's documents as a positive JSON match, scoped to the project's clips", async () => {
    const client = fakeClient({});
    await countDurableWork(client as never, { projectId: "p" });
    expect(client.clipEdit.count).toHaveBeenNthCalledWith(2, {
      where: {
        clip: { projectId: "p" },
        editorState: { path: ["systemInitial"], equals: true },
      },
    });
  });

  it("counts a post by the states a rebuild would detach, not by the states it re-derives", async () => {
    const client = fakeClient({});
    await countDurableWork(client as never, { projectId: "p" });
    const where = client.scheduledPost.count.mock.calls[0][0].where;
    expect(where.publishStatus.in).toEqual(["IN_PROGRESS", "SUCCEEDED", "BLOCKED", "UNFILLED", "MISSED"]);
    expect(where.publishStatus.in).not.toContain("NOT_STARTED");
    expect(where.publishStatus.in).not.toContain("FAILED");
    // Both ways a slot can belong to the project: through its clip, or directly once the clip is gone.
    expect(where.OR).toEqual([{ clip: { projectId: "p" } }, { projectId: "p" }]);
  });
});

describe("assessReanalysis", () => {
  it("allows a project nobody has touched", async () => {
    await expect(assessReanalysis(fakeClient({}) as never, { projectId: "p" })).resolves.toEqual({
      allowed: true,
    });
  });

  it.each([
    ["an edit", { edits: 1 }],
    ["an approval", { approvals: 1 }],
    ["an export", { exports: 1 }],
    ["a delivered post", { posts: 1 }],
  ])("refuses once %s exists, and says what it found", async (_label, counts) => {
    const assessment = await assessReanalysis(fakeClient(counts) as never, { projectId: "p" });
    expect(assessment.allowed).toBe(false);
    if (assessment.allowed) throw new Error("unreachable");
    expect(hasDurableWork(assessment.work)).toBe(true);
  });
});

describe("the refusal", () => {
  it("is terminal and leaves the project as it found it", () => {
    const error = reanalysisBlockedError({ edits: 1, approvals: 0, exports: 0, posts: 0 });
    expect(error).toBeInstanceOf(JobFailureError);
    expect(error.code).toBe(REANALYSIS_BLOCKED);
    expect(error.retryable).toBe(false);
    expect(error.preservesProject).toBe(true);
    // The church-visible message names the remedy, not the counts.
    expect(error.userMessage).toMatch(/upload it as a new project/);
    // The counts go to the operator, through the failure's cause, as a sentence.
    expect((error.cause as Error).message).toMatch(/1 saved edit\(s\)/);
  });

  it("is what assertReanalysisAllowed throws, and only when there is work", async () => {
    await expect(
      assertReanalysisAllowed(fakeClient({}) as never, { projectId: "p" }),
    ).resolves.toBeUndefined();
    await expect(
      assertReanalysisAllowed(fakeClient({ exports: 1 }) as never, { projectId: "p" }),
    ).rejects.toMatchObject({ code: REANALYSIS_BLOCKED });
  });
});
