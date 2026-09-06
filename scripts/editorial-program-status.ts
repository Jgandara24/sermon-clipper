import { PrismaClient } from "@prisma/client";
import { editorialProgramStatus } from "@/lib/review/editorial-program";
import { HUMAN_REFERENCE_MINIMUM_DAYS } from "@/lib/review/program-key";

/**
 * Where the human-only phase stands: how long it has actually run, what was decided in it, and
 * whether anything has contaminated it.
 *
 * Read-only. Prints the two numbers that matter — elapsed days and agent rows — before anything
 * else, because those are the two that can invalidate the phase.
 */

function days(ms: number): string {
  return `${(ms / 86_400_000).toFixed(2)} day(s)`;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const status = await editorialProgramStatus(prisma);
    if (!status) {
      console.log("The human-reference program has not been started.");
      console.log(
        `Run \`npm run program:evidence\` to see which of the ${HUMAN_REFERENCE_MINIMUM_DAYS}-day ` +
          "phase's start preconditions the database can prove.",
      );
      process.exitCode = 1;
      return;
    }

    console.log(`Program:        ${status.key}`);
    console.log(`State:          ${status.state}`);
    console.log(`Started:        ${status.startedAt?.toISOString() ?? "never"}`);
    console.log(`Started by:     ${status.startedByEmail ?? "unknown"}`);
    console.log(
      `Elapsed:        ${status.elapsedDays} of ${status.minimumDays} full day(s)` +
        (status.minimumMet ? "  — minimum served" : "  — held"),
    );
    if (status.pausedMs > 0 || status.pausedAt) {
      console.log(
        `Paused:         ${days(status.pausedMs)} banked` +
          (status.pausedAt ? `, currently paused since ${status.pausedAt.toISOString()}` : "") +
          "  (a pause extends the phase; it never shortens it)",
      );
    }
    console.log(
      `Authority:      human${status.minimumMet ? " — and still human: only P7, deployed and explicitly changed, moves that" : ""}`,
    );

    if (status.agentReviews > 0) {
      console.error(
        `\nCONTAMINATED: ${status.agentReviews} agent-written review(s) landed inside the ` +
          "window. A human-reference phase with machine decisions in it is not a reference set.",
      );
      process.exitCode = 1;
    } else {
      console.log("Agent rows:     none — the window is clean");
    }

    console.log(
      `\nDecisions:      ${status.decisions.total} ` +
        `(${status.decisions.accept} accept, ${status.decisions.revise} revise, ` +
        `${status.decisions.replace} replace)`,
    );
    console.log(
      `Review latency: ${status.reviewLatency.measured} measured` +
        (status.reviewLatency.medianMs === null
          ? ""
          : `, median ${days(status.reviewLatency.medianMs)}, slowest ${days(status.reviewLatency.slowestMs ?? 0)}`),
    );

    if (status.cohorts.length > 0) {
      console.log("\nCohorts:");
      for (const cohort of status.cohorts) {
        console.log(`  ${cohort.churchName}: ${cohort.cohort}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
