// P1.7: reanalysis is refused once durable work exists on a project's clips.
//
// Re-running ANALYZE rebuilds the clips. It deletes every GeneratedClip for the project, and
// ClipEdit, ClipApproval and ExportJob cascade from them — so a person's edits, a church's
// approval and every rendered file go with them. A ScheduledPost survives with its clip set to
// null, which keeps a published post on record but detaches it from the thing that was posted.
// Re-running TRANSCRIBE is the same event one step earlier: it replaces the transcript, and word
// ids are positional, so every correction and every cut a person made points at different words.
// None of that can be undone.
//
// So the question is asked before anything is destroyed, and answered from the database: does
// any durable work exist? If it does, the rebuild is refused and the reason is named. Keeping old
// clips beside new ones — versioned analysis — is later work. Until then the answer is to refuse,
// which is the plan's "block now, version later".

import type { Prisma, PrismaClient } from "@prisma/client";
import { JobFailureError } from "@/lib/jobs/types";

export const REANALYSIS_BLOCKED = "REANALYSIS_BLOCKED";

export const REANALYSIS_BLOCKED_MESSAGE =
  "This sermon's clips have been edited, approved, exported, or scheduled, so they were not " +
  "regenerated. To analyse it again, upload it as a new project.";

export type DurableWorkCounts = {
  /** Editor documents a person saved: every ClipEdit that is not the machine's initial one. */
  edits: number;
  /** Approval records, in any state — a request sent to a church is already a fact. */
  approvals: number;
  /** Export jobs, in any state — a render that was asked for is work, finished or not. */
  exports: number;
  /** Scheduled posts in flight, published, or blocked by an operator: a record this project delivered. */
  posts: number;
};

export type ReanalysisAssessment =
  | { allowed: true }
  | { allowed: false; work: DurableWorkCounts };

export type ReanalysisPolicyClient =
  | Pick<PrismaClient, "clipEdit" | "clipApproval" | "exportJob" | "scheduledPost">
  | Prisma.TransactionClient;

/**
 * Publish states that a rebuild would silently detach from their clip.
 *
 * A durable row is one that records something reaching an audience, or a decision a person made:
 * a claim in flight, a post that succeeded, a slot an operator blocked. A rebuild must not
 * detach those, and `clearReschedulableScheduledPosts` deliberately leaves them alone.
 *
 * MISSED and UNFILLED were listed here by P1.7, when no code created either state. P1.9 creates
 * both routinely — every sermon uploaded after its own posting week produces MISSED rows, and
 * every thin candidate pool produces UNFILLED ones. Left durable, the first analysis of an old
 * sermon would permanently forbid re-analysing it. Neither reached an audience and neither
 * carries a human decision, so both are reschedulable, and `clearReschedulableScheduledPosts`
 * now clears them rather than leaving them behind detached.
 */
const DURABLE_PUBLISH_STATES = ["IN_PROGRESS", "SUCCEEDED", "BLOCKED"] as const;

/** Counts the durable work on a project's clips. Every count is a database count, never a load. */
export async function countDurableWork(
  client: ReanalysisPolicyClient,
  params: { projectId: string },
): Promise<DurableWorkCounts> {
  const clipScope = { clip: { projectId: params.projectId } };
  const [totalEdits, systemEdits, approvals, exports, posts] = await Promise.all([
    client.clipEdit.count({ where: clipScope }),
    // ANALYZE writes each clip's first document itself. Asked as a positive — "is this the
    // machine's document?" — for the reason the fallback hold records: a negative JSON filter is
    // NULL for every row without the key, which is every human edit.
    client.clipEdit.count({
      where: { ...clipScope, editorState: { path: ["systemInitial"], equals: true } },
    }),
    client.clipApproval.count({ where: clipScope }),
    client.exportJob.count({ where: clipScope }),
    client.scheduledPost.count({
      where: {
        OR: [clipScope, { projectId: params.projectId }],
        publishStatus: { in: [...DURABLE_PUBLISH_STATES] },
      },
    }),
  ]);
  return { edits: Math.max(0, totalEdits - systemEdits), approvals, exports, posts };
}

export function hasDurableWork(work: DurableWorkCounts): boolean {
  return work.edits + work.approvals + work.exports + work.posts > 0;
}

/** Whether the project's clips may be rebuilt, and if not, what stands in the way. */
export async function assessReanalysis(
  client: ReanalysisPolicyClient,
  params: { projectId: string },
): Promise<ReanalysisAssessment> {
  const work = await countDurableWork(client, params);
  return hasDurableWork(work) ? { allowed: false, work } : { allowed: true };
}

/**
 * The refusal, as the job handlers throw it.
 *
 * Terminal, because the same project reaches the same answer on every retry — only a person can
 * change it. And it leaves the project as it found it: the clips are intact and the project is
 * not failed, so the runner must not mark it so.
 */
export function reanalysisBlockedError(work: DurableWorkCounts): JobFailureError {
  return new JobFailureError(REANALYSIS_BLOCKED, REANALYSIS_BLOCKED_MESSAGE, {
    retryable: false,
    preservesProject: true,
    // The runner surfaces a failure's cause as text in the operational event, so the counts go
    // in as a sentence an operator can read, not as an object that prints as [object Object].
    cause: new Error(describeDurableWork(work)),
  });
}

/** The counts as one line, for the event that records the refusal. */
export function describeDurableWork(work: DurableWorkCounts): string {
  return (
    `durable work on this project's clips: ${work.edits} saved edit(s), ` +
    `${work.approvals} approval record(s), ${work.exports} export job(s), ` +
    `${work.posts} scheduled post(s) in flight, published or blocked`
  );
}

/** Refuses with the durable-work counts, or returns them when the rebuild may proceed. */
export async function assertReanalysisAllowed(
  client: ReanalysisPolicyClient,
  params: { projectId: string },
): Promise<void> {
  const assessment = await assessReanalysis(client, params);
  if (!assessment.allowed) throw reanalysisBlockedError(assessment.work);
}
