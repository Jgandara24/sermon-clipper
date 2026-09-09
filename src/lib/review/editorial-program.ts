import {
  ClipReviewDecision,
  EditorialCohort,
  EditorialProgramState,
  ReviewerKind,
  type EditorialProgram,
  type PrismaClient,
} from "@prisma/client";
import { collectSwitchOnlyCensus, type SwitchOnlyCensus } from "@/lib/delivery/query";
import {
  HUMAN_REFERENCE_MINIMUM_DAYS,
  HUMAN_REFERENCE_PROGRAM_KEY,
} from "@/lib/review/program-key";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";

/**
 * The fixed 30-day human-only reference phase: starting it, reporting it, and pausing it.
 *
 * The phase is the product's evidence base. Everything P4 through P7 later claim about an agent
 * reviewer is measured against decisions a person made in this window, so the window's boundaries
 * have to be facts rather than recollections. That is what makes the start an explicit, recorded,
 * refusable act instead of a date someone remembers.
 *
 * Three rules shape the whole module:
 *
 * 1. **The clock cannot be backdated.** `startedAt` is the moment the command ran. There is no
 *    parameter for it. A phase whose start could be moved backwards is a phase whose length is an
 *    opinion.
 * 2. **A pause extends, never shortens.** Paused time is subtracted from elapsed time, so
 *    stopping the program for a week means the thirtieth day arrives a week later.
 * 3. **The start is refused without evidence that the system works end to end.** Not a checklist
 *    a human ticks — rows this module goes and finds.
 */

const DAY_MS = 86_400_000;

export class EditorialProgramError extends Error {}

export class ProgramAlreadyStartedError extends EditorialProgramError {
  constructor(readonly state: EditorialProgramState) {
    super(
      `The human-reference program is already ${state}. It starts once; elapsed history is never ` +
        "erased and the clock is never restarted.",
    );
    this.name = "ProgramAlreadyStartedError";
  }
}

export class ProgramNotStartedError extends EditorialProgramError {
  constructor() {
    super("The human-reference program has not been started.");
    this.name = "ProgramNotStartedError";
  }
}

export class ProgramEvidenceMissingError extends EditorialProgramError {
  constructor(readonly missing: readonly string[]) {
    super(
      `The human-reference program cannot start until the system has been proved end to end. ` +
        `Missing: ${missing.join("; ")}.`,
    );
    this.name = "ProgramEvidenceMissingError";
  }
}

/**
 * What the start command goes looking for, and what it found.
 *
 * Each fact is a row, not a flag. A start that trusted an operator's assertion that the smoke test
 * passed would record the assertion, not the proof.
 */
export type StartEvidence = {
  /**
   * One slot whose bound export succeeded, passed QC against exactly its own file, and carries a
   * human `ACCEPT` of all four identity facts.
   *
   * That single row is four of the plan's preconditions at once: a file exists to play, a review
   * was written, QC ran, and delivery's exact-acceptance gate has something it would accept.
   */
  exactAcceptedRender: { scheduledPostId: string; exportJobId: string; reviewId: string } | null;
  /** One `REPLACE` decision. Only `replaceScheduledClip` can write one, so its existence is the proof. */
  atomicReplacement: { reviewId: string; scheduledPostId: string; replacedClipId: string | null } | null;
  /**
   * One slot published to a real Page whose bound export is the one a human accepted.
   *
   * "Verify the exact accepted export and provider result" is both halves of this: a
   * `facebookPostId` says the provider answered, and the acceptance matching the still-bound
   * export says what it answered about.
   */
  sandboxPublication: {
    scheduledPostId: string;
    exportJobId: string;
    facebookPostId: string;
    publishedAt: Date | null;
  } | null;
};

export type EditorialProgramStatus = {
  key: string;
  state: EditorialProgramState;
  startedAt: Date | null;
  startedByEmail: string | null;
  pausedAt: Date | null;
  minimumDays: number;
  /** Wall time since the start, less every paused interval. Zero before the program starts. */
  elapsedMs: number;
  /** Whole days of that. Day 29 is 29; the phase is met at 30. */
  elapsedDays: number;
  pausedMs: number;
  /** Whether the fixed minimum has been served. Never shortened by early evidence. */
  minimumMet: boolean;
  /**
   * Always true through P2–P6. The end of the 30 days is when the *next* phase may be considered,
   * not when a person stops being the authority — only P7, deployed and explicitly changed, moves
   * this.
   */
  humanAuthoritative: true;
  cohorts: { workspaceId: string; churchName: string; cohort: EditorialCohort }[];
  decisions: { accept: number; revise: number; replace: number; total: number };
  /**
   * Reviews an agent wrote inside the window. Must be zero: a reference phase contaminated by
   * machine decisions is not a reference for anything.
   */
  agentReviews: number;
  /** How long renders waited for a person, measured from the bound export finishing. */
  reviewLatency: { measured: number; medianMs: number | null; slowestMs: number | null };
};

/**
 * The facts a status report is computed from — rows in, no queries.
 *
 * Split out so the arithmetic that decides whether the phase is served has a truth table of its
 * own. "Day 29 is held, day 30 is not" and "a pause extends the phase" are the two claims the
 * whole program rests on, and neither should need a database to state.
 */
export type ProgramSummaryInput = {
  program: Pick<
    EditorialProgram,
    "key" | "state" | "startedAt" | "pausedAt" | "pausedMs" | "minimumDays"
  >;
  startedByEmail: string | null;
  cohorts: { workspaceId: string; churchName: string; cohort: EditorialCohort }[];
  /** Every review inside the window, with the bound export's finish time where it survives. */
  reviews: {
    decision: ClipReviewDecision;
    reviewerKind: ReviewerKind;
    createdAt: Date;
    exportFinishedAt: Date | null;
  }[];
  now: Date;
};

/** Elapsed time that has actually run, with any open pause already subtracted. */
export function activeElapsedMs(
  program: Pick<EditorialProgram, "startedAt" | "pausedAt" | "pausedMs">,
  now: Date,
): number {
  if (!program.startedAt) return 0;
  const gross = now.getTime() - program.startedAt.getTime();
  // Subtracting the open pause as well as the banked total is what makes a pause hold the clock
  // rather than merely record that it stopped. Without it the phase would keep maturing while
  // paused and the pause would only take effect on resume.
  const openPause = program.pausedAt ? now.getTime() - program.pausedAt.getTime() : 0;
  return Math.max(0, gross - Number(program.pausedMs) - openPause);
}

/** The report, computed. Pure. */
export function summariseEditorialProgram(input: ProgramSummaryInput): EditorialProgramStatus {
  const { program } = input;
  const elapsedMs = activeElapsedMs(program, input.now);
  const elapsedDays = Math.floor(elapsedMs / DAY_MS);

  const decisions = { accept: 0, revise: 0, replace: 0, total: 0 };
  const latencies: number[] = [];
  let agentReviews = 0;

  for (const review of input.reviews) {
    if (review.reviewerKind === ReviewerKind.AGENT) {
      agentReviews += 1;
      continue;
    }
    decisions.total += 1;
    if (review.decision === ClipReviewDecision.ACCEPT) decisions.accept += 1;
    else if (review.decision === ClipReviewDecision.REVISE) decisions.revise += 1;
    else decisions.replace += 1;

    // Null once retention has deleted the export. The decision still counts; only its latency
    // becomes unmeasurable, which is why the two carry separate denominators.
    if (review.exportFinishedAt) {
      latencies.push(Math.max(0, review.createdAt.getTime() - review.exportFinishedAt.getTime()));
    }
  }
  latencies.sort((a, b) => a - b);

  return {
    key: program.key,
    state: program.state,
    startedAt: program.startedAt,
    startedByEmail: input.startedByEmail,
    pausedAt: program.pausedAt,
    minimumDays: program.minimumDays,
    elapsedMs,
    elapsedDays,
    pausedMs: Number(program.pausedMs),
    minimumMet: elapsedDays >= program.minimumDays,
    humanAuthoritative: true,
    cohorts: input.cohorts,
    decisions,
    agentReviews,
    reviewLatency: {
      measured: latencies.length,
      medianMs: latencies.length > 0 ? latencies[Math.floor((latencies.length - 1) / 2)] : null,
      slowestMs: latencies.length > 0 ? latencies[latencies.length - 1] : null,
    },
  };
}

export async function findEditorialProgram(
  client: Pick<PrismaClient, "editorialProgram">,
): Promise<EditorialProgram | null> {
  return client.editorialProgram.findUnique({ where: { key: HUMAN_REFERENCE_PROGRAM_KEY } });
}

/**
 * The three durable facts the start requires, gathered from rows.
 *
 * Read-only, and safe to run before a start to see what is still missing.
 */
export async function collectStartEvidence(client: PrismaClient): Promise<StartEvidence> {
  // A human ACCEPT whose four identity facts still match a slot's bound, QC-passed export. The
  // join is written from the review's side because the review is the scarce row.
  const acceptances = await client.clipReview.findMany({
    where: { decision: ClipReviewDecision.ACCEPT, reviewerKind: ReviewerKind.HUMAN },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      scheduledPostIdSnapshot: true,
      clipIdSnapshot: true,
      exportJobIdSnapshot: true,
      editVersion: true,
      checksum: true,
    },
  });

  let exactAcceptedRender: StartEvidence["exactAcceptedRender"] = null;
  let sandboxPublication: StartEvidence["sandboxPublication"] = null;

  for (const review of acceptances) {
    const slot = await client.scheduledPost.findUnique({
      where: { id: review.scheduledPostIdSnapshot },
      select: {
        id: true,
        clipId: true,
        publishStatus: true,
        facebookPostId: true,
        publishedAt: true,
        exportJob: {
          select: {
            id: true,
            state: true,
            editVersion: true,
            qcStatus: true,
            qcChecksum: true,
            outputFile: { select: { checksum: true } },
          },
        },
      },
    });
    const job = slot?.exportJob;
    const stillTheSameRender =
      slot &&
      job &&
      slot.clipId === review.clipIdSnapshot &&
      job.id === review.exportJobIdSnapshot &&
      job.editVersion === review.editVersion &&
      job.qcChecksum === review.checksum &&
      job.state === "SUCCEEDED" &&
      job.qcStatus === "PASSED" &&
      job.qcChecksum === job.outputFile?.checksum;
    if (!stillTheSameRender) continue;

    exactAcceptedRender ??= {
      scheduledPostId: slot.id,
      exportJobId: job.id,
      reviewId: review.id,
    };

    // The same row, having actually gone out to a Page. Checked here rather than in a separate
    // query so that "published" and "published the accepted export" cannot come from two slots.
    if (!sandboxPublication && slot.publishStatus === "SUCCEEDED" && slot.facebookPostId) {
      sandboxPublication = {
        scheduledPostId: slot.id,
        exportJobId: job.id,
        facebookPostId: slot.facebookPostId,
        publishedAt: slot.publishedAt,
      };
    }
  }

  const replacement = await client.clipReview.findFirst({
    where: { decision: ClipReviewDecision.REPLACE },
    orderBy: { createdAt: "asc" },
    select: { id: true, scheduledPostIdSnapshot: true, clipIdSnapshot: true },
  });

  return {
    exactAcceptedRender,
    atomicReplacement: replacement
      ? {
          reviewId: replacement.id,
          scheduledPostId: replacement.scheduledPostIdSnapshot,
          replacedClipId: replacement.clipIdSnapshot,
        }
      : null,
    sandboxPublication,
  };
}

/** The evidence that is absent, named the way the runbook names it. */
export function missingEvidence(evidence: StartEvidence): string[] {
  const missing: string[] = [];
  if (!evidence.exactAcceptedRender) {
    missing.push(
      "no slot has a QC-passed bound export with a human ACCEPT of exactly it (exact playback, " +
        "review writes, QC and delivery gating are proved together by that one row)",
    );
  }
  if (!evidence.atomicReplacement) {
    missing.push("no REPLACE decision exists, so the atomic replacement path is unproved");
  }
  if (!evidence.sandboxPublication) {
    missing.push(
      "no accepted render has been published to a real Page, so the sandbox publication " +
        "sequence is unproved",
    );
  }
  return missing;
}

export type SandboxProof =
  | { ok: true; census: SwitchOnlyCensus; intendedScheduledPostId: string }
  | { ok: false; reason: SandboxProofFailure; census: SwitchOnlyCensus; detail: string };

export type SandboxProofFailure =
  | "global_switch_already_enabled"
  | "intended_row_not_switch_only"
  | "other_rows_would_publish";

/**
 * Check that only the intended due row passes the database and local process prerequisites
 * with the global switch simulated on. Any other set is a refusal. This does not authorize
 * activation, verify live Meta access or media retrieval, or prevent later state changes.
 *
 * It refuses outright if the switch is already on. A census taken with publishing live is not a
 * dry run; the rows it would have released may already be gone.
 *
 * Attempts to record the outcome either way through the best-effort operational audit writer.
 */
export async function verifySandboxProof(
  client: PrismaClient,
  input: { intendedScheduledPostId: string; now?: Date },
): Promise<SandboxProof> {
  const now = input.now ?? new Date();
  const census = await collectSwitchOnlyCensus(client, { now });

  const result = ((): SandboxProof => {
    if (census.globalPublishingEnabled) {
      return {
        ok: false,
        reason: "global_switch_already_enabled",
        census,
        detail:
          "AUTOMATIC_PUBLISHING_ENABLED is already true. The sandbox proof is only meaningful " +
          "with publishing off, because it is a claim about what turning it on would release.",
      };
    }

    const ids = census.switchOnly.map((row) => row.scheduledPostId);
    const intendedIsSwitchOnly = ids.includes(input.intendedScheduledPostId);
    const others = ids.filter((id) => id !== input.intendedScheduledPostId);

    if (!intendedIsSwitchOnly) {
      const row = census.rows.find((r) => r.scheduledPostId === input.intendedScheduledPostId);
      const why = row
        ? row.withSwitchOn.eligible
          ? "it is not refused for the switch alone"
          : `it would still fail: ${row.withSwitchOn.reason}`
        : "it is not among the due rows at all";
      return {
        ok: false,
        reason: "intended_row_not_switch_only",
        census,
        detail: `The intended sandbox row does not pass the checked prerequisites with the switch on: ${why}.`,
      };
    }

    if (others.length > 0) {
      return {
        ok: false,
        reason: "other_rows_would_publish",
        census,
        detail:
          `${others.length} other due row(s) also pass the checked prerequisites with the switch on: ` +
          `${others.join(", ")}. Do not enable publishing.`,
      };
    }

    return { ok: true, census, intendedScheduledPostId: input.intendedScheduledPostId };
  })();

  await recordOperationalEventSafely(client, {
    category: "editorial_program",
    eventType: result.ok ? "sandbox_proof_passed" : "sandbox_proof_refused",
    severity: result.ok ? "info" : "warning",
    message: result.ok
      ? "Only the intended row passed the checked prerequisites with the switch simulated on. This does not authorize activation or verify live Meta access or media retrieval."
      : `The sandbox dry run refused: ${result.detail}`,
    metadata: {
      intendedScheduledPostId: input.intendedScheduledPostId,
      dueRows: census.rows.length,
      switchOnlyRows: census.switchOnly.map((row) => row.scheduledPostId),
      globalPublishingEnabled: census.globalPublishingEnabled,
      environment: census.environment,
      takenAt: census.takenAt.toISOString(),
      activationAuthorized: false,
      scope: "due_rows_database_prerequisites_and_local_process_configuration",
      liveMetaAccessChecked: false,
      mediaRetrievalChecked: false,
      ...(result.ok ? {} : { reason: result.reason }),
    },
  });

  return result;
}

/**
 * Starts the clock, once, now.
 *
 * There is no start date parameter and there never will be. The evidence is re-gathered here
 * rather than accepted from the caller, so the command refuses on the state of the database at
 * the moment it runs — not on what was true when someone last looked.
 */
export async function startEditorialProgram(
  client: PrismaClient,
  input: { startedByUserId: string; now?: Date },
): Promise<EditorialProgram> {
  const now = input.now ?? new Date();

  const existing = await findEditorialProgram(client);
  if (existing && existing.state !== EditorialProgramState.NOT_STARTED) {
    throw new ProgramAlreadyStartedError(existing.state);
  }

  const evidence = await collectStartEvidence(client);
  const missing = missingEvidence(evidence);
  if (missing.length > 0) throw new ProgramEvidenceMissingError(missing);

  const startEvidence = {
    recordedAt: now.toISOString(),
    exactAcceptedRender: evidence.exactAcceptedRender,
    atomicReplacement: evidence.atomicReplacement,
    sandboxPublication: {
      ...evidence.sandboxPublication,
      publishedAt: evidence.sandboxPublication?.publishedAt?.toISOString() ?? null,
    },
  };

  const program = await client.editorialProgram.upsert({
    where: { key: HUMAN_REFERENCE_PROGRAM_KEY },
    create: {
      key: HUMAN_REFERENCE_PROGRAM_KEY,
      state: EditorialProgramState.ACTIVE,
      minimumDays: HUMAN_REFERENCE_MINIMUM_DAYS,
      startedAt: now,
      startedByUserId: input.startedByUserId,
      startEvidence,
    },
    update: {
      state: EditorialProgramState.ACTIVE,
      minimumDays: HUMAN_REFERENCE_MINIMUM_DAYS,
      startedAt: now,
      startedByUserId: input.startedByUserId,
      startEvidence,
    },
  });

  await recordOperationalEventSafely(client, {
    category: "editorial_program",
    eventType: "editorial_program_started",
    message: `The fixed ${HUMAN_REFERENCE_MINIMUM_DAYS}-day human-only review phase started.`,
    metadata: { startedAt: now.toISOString(), startedByUserId: input.startedByUserId },
  });

  return program;
}

/**
 * Pauses the program, and with it delivery.
 *
 * The documented rollback. Elapsed days are kept exactly as they stand — pausing costs the
 * calendar, never the record.
 */
export async function pauseEditorialProgram(
  client: PrismaClient,
  input: { reason: string; now?: Date },
): Promise<EditorialProgram> {
  const now = input.now ?? new Date();
  const program = await findEditorialProgram(client);
  if (!program || program.state === EditorialProgramState.NOT_STARTED) {
    throw new ProgramNotStartedError();
  }
  if (program.state === EditorialProgramState.PAUSED) return program;

  const paused = await client.editorialProgram.update({
    where: { key: HUMAN_REFERENCE_PROGRAM_KEY },
    data: { state: EditorialProgramState.PAUSED, pausedAt: now },
  });

  await recordOperationalEventSafely(client, {
    category: "editorial_program",
    eventType: "editorial_program_paused",
    severity: "warning",
    message: `The human review program was paused, which pauses delivery: ${input.reason}`,
    metadata: { pausedAt: now.toISOString(), reason: input.reason },
  });

  return paused;
}

/** Resumes, banking the paused interval so the thirtieth day moves out by exactly that much. */
export async function resumeEditorialProgram(
  client: PrismaClient,
  input: { now?: Date } = {},
): Promise<EditorialProgram> {
  const now = input.now ?? new Date();
  const program = await findEditorialProgram(client);
  if (!program || program.state === EditorialProgramState.NOT_STARTED) {
    throw new ProgramNotStartedError();
  }
  if (program.state !== EditorialProgramState.PAUSED) return program;

  const bankedMs = program.pausedAt ? Math.max(0, now.getTime() - program.pausedAt.getTime()) : 0;

  const resumed = await client.editorialProgram.update({
    where: { key: HUMAN_REFERENCE_PROGRAM_KEY },
    data: {
      state: EditorialProgramState.ACTIVE,
      pausedAt: null,
      pausedMs: BigInt(Number(program.pausedMs) + bankedMs),
    },
  });

  await recordOperationalEventSafely(client, {
    category: "editorial_program",
    eventType: "editorial_program_resumed",
    message: "The human review program resumed.",
    metadata: { resumedAt: now.toISOString(), bankedPauseMs: bankedMs },
  });

  return resumed;
}

/** The report the operator page and the status script both render. */
export async function editorialProgramStatus(
  client: PrismaClient,
  input: { now?: Date } = {},
): Promise<EditorialProgramStatus | null> {
  const now = input.now ?? new Date();
  const program = await client.editorialProgram.findUnique({
    where: { key: HUMAN_REFERENCE_PROGRAM_KEY },
    include: {
      startedBy: { select: { email: true } },
      workspaces: { include: { workspace: { select: { name: true } } } },
    },
  });
  if (!program) return null;

  // Scoped to the window. Decisions made before the clock started are real history, but they are
  // not the reference set this phase exists to collect.
  const since = program.startedAt ?? now;
  const reviews = await client.clipReview.findMany({
    where: { createdAt: { gte: since } },
    select: {
      decision: true,
      reviewerKind: true,
      createdAt: true,
      exportJob: { select: { finishedAt: true } },
    },
  });

  return summariseEditorialProgram({
    program,
    startedByEmail: program.startedBy?.email ?? null,
    cohorts: program.workspaces.map((row) => ({
      workspaceId: row.workspaceId,
      churchName: row.workspace.name,
      cohort: row.cohort,
    })),
    reviews: reviews.map((review) => ({
      decision: review.decision,
      reviewerKind: review.reviewerKind,
      createdAt: review.createdAt,
      exportFinishedAt: review.exportJob?.finishedAt ?? null,
    })),
    now,
  });
}
