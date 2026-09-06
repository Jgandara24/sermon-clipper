import { SchedulePublishStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  assessFinalRender,
  FINAL_RENDER_REFUSED_MESSAGE,
  RENDERABLE_SLOT_STATES,
} from "@/lib/review/final-render-eligibility";
import { coordinateScheduledRenders } from "@/lib/review/render-coordinator";

/** A client whose only job is to answer "how many renderable slots hold this clip?". */
function clientWithSlots(count: number) {
  const scheduledPostCount = vi.fn().mockResolvedValue(count);
  return { client: { scheduledPost: { count: scheduledPostCount } }, scheduledPostCount };
}

describe("the final-render rule while automatic publishing is off", () => {
  it("allows everything, and does not even ask the database", async () => {
    // The rule exists to stop paying for renders that will never publish. Nothing publishes yet,
    // so there is nothing for it to save — and a church's manual export predates all of this.
    const { client, scheduledPostCount } = clientWithSlots(0);

    await expect(
      assessFinalRender(client as never, { clipId: "clip-1" }, { publishingEnabled: false }),
    ).resolves.toEqual({ allowed: true, reason: "DELIVERY_REGIME_OFF" });
    expect(scheduledPostCount).not.toHaveBeenCalled();
  });

  it("lets a scheduled clip take the explicit manual sandbox-render path", async () => {
    // The P2.9 sandbox proof needs exactly this: one manual render of a scheduled clip, made
    // while the switch is still false.
    const { client } = clientWithSlots(1);
    await expect(
      assessFinalRender(client as never, { clipId: "clip-1" }, { publishingEnabled: false }),
    ).resolves.toMatchObject({ allowed: true });
  });
});

describe("the final-render rule while automatic publishing is on", () => {
  it("allows a clip a slot is waiting on", async () => {
    const { client, scheduledPostCount } = clientWithSlots(1);
    await expect(
      assessFinalRender(client as never, { clipId: "clip-1" }, { publishingEnabled: true }),
    ).resolves.toEqual({ allowed: true, reason: "SCHEDULED" });
    expect(scheduledPostCount).toHaveBeenCalledOnce();
  });

  it("refuses an unscheduled reserve, and says what to do about it", async () => {
    const { client } = clientWithSlots(0);
    await expect(
      assessFinalRender(client as never, { clipId: "clip-1" }, { publishingEnabled: true }),
    ).resolves.toEqual({
      allowed: false,
      reason: "UNSCHEDULED_RESERVE",
      message: FINAL_RENDER_REFUSED_MESSAGE,
    });
  });

  it("asks only about slots that can still receive a render", async () => {
    const { client, scheduledPostCount } = clientWithSlots(1);
    await assessFinalRender(client as never, { clipId: "clip-1" }, { publishingEnabled: true });

    const where = scheduledPostCount.mock.calls[0][0].where;
    expect(where.clipId).toBe("clip-1");
    // SUCCEEDED is done and MISSED is a date that passed; a fresh render buys nothing and costs
    // money, and would muddy which file was posted.
    expect(where.publishStatus.in).not.toContain(SchedulePublishStatus.SUCCEEDED);
    expect(where.publishStatus.in).not.toContain(SchedulePublishStatus.MISSED);
    expect(where.publishStatus.in).toContain(SchedulePublishStatus.NOT_STARTED);
    // A REVISE leaves the slot NOT_STARTED and needs another render; a FAILED slot may retry;
    // BLOCKED is an operator hold a person can lift.
    expect(where.publishStatus.in).toContain(SchedulePublishStatus.FAILED);
    expect(where.publishStatus.in).toContain(SchedulePublishStatus.BLOCKED);
  });

  it("names every renderable state exactly once", () => {
    expect(new Set(RENDERABLE_SLOT_STATES).size).toBe(RENDERABLE_SLOT_STATES.length);
    const everyState = Object.values(SchedulePublishStatus);
    const excluded = everyState.filter((state) => !RENDERABLE_SLOT_STATES.includes(state));
    expect(excluded.sort()).toEqual(
      [SchedulePublishStatus.SUCCEEDED, SchedulePublishStatus.MISSED].sort(),
    );
  });
});

describe("the coordinator while the switch is off", () => {
  it("records no export work at all — no query, no job, no binding", async () => {
    // Not "enqueues and holds". The switch is the last thing between this repository and a real
    // church's page, and a queue built quietly behind it would make flipping it far more
    // dangerous than it looks.
    const findMany = vi.fn();
    const client = { scheduledPost: { findMany } };

    await expect(
      coordinateScheduledRenders(client as never, { publishingEnabled: false }),
    ).resolves.toEqual({
      enabled: false,
      slotsScanned: 0,
      slotsBound: 0,
      jobsCreated: 0,
      failures: [],
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("is off when the variable is missing or is anything but the exact string true", async () => {
    const original = process.env.AUTOMATIC_PUBLISHING_ENABLED;
    const findMany = vi.fn();
    const client = { scheduledPost: { findMany } };
    try {
      for (const value of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
        if (value === undefined) delete process.env.AUTOMATIC_PUBLISHING_ENABLED;
        else process.env.AUTOMATIC_PUBLISHING_ENABLED = value;
        const outcome = await coordinateScheduledRenders(client as never);
        expect(outcome.enabled, `value ${JSON.stringify(value)}`).toBe(false);
      }
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.AUTOMATIC_PUBLISHING_ENABLED;
      else process.env.AUTOMATIC_PUBLISHING_ENABLED = original;
    }
  });
});
