import { PrismaClient } from "@prisma/client";
import {
  collectStartEvidence,
  EditorialProgramError,
  missingEvidence,
  pauseEditorialProgram,
  resumeEditorialProgram,
  startEditorialProgram,
  verifySandboxProof,
} from "@/lib/review/editorial-program";
import { HUMAN_REFERENCE_MINIMUM_DAYS } from "@/lib/review/program-key";

/**
 * The start sequence for the fixed human-only phase, and its rollback.
 *
 * Four steps, deliberately separate commands rather than one flag-driven run. The sandbox proof
 * and the start are days apart in the runbook — the proof gates turning the global switch on, the
 * publish happens, and only then is there evidence to start on.
 *
 * See `docs/HUMAN_REVIEW_30_DAY_RUNBOOK.md` for the order and what each step is proving.
 */

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const USAGE = `Usage:
  npm run program:evidence
      Show which start preconditions the database can prove, and which it cannot.

  npm run program:sandbox-proof -- --post <scheduled-post-uuid>
      The dry run. Proves that with the global switch simulated on, exactly this row would
      publish. Refuses if any other due row would, or if the switch is already enabled.
      Run this BEFORE enabling AUTOMATIC_PUBLISHING_ENABLED. If it refuses, do not enable.

  npm run program:start -- (--user-id <uuid> | --email <address>)
      Start the fixed ${HUMAN_REFERENCE_MINIMUM_DAYS}-day clock. Refused without the evidence
      above. The start time is now; there is no way to backdate it.

  npm run program:pause -- --reason "<why>"
  npm run program:resume
      Pause stops delivery everywhere and holds the clock. Resuming banks the paused interval,
      so the thirtieth day moves out by exactly as long as the pause lasted.`;

async function main() {
  const args = process.argv.slice(2);
  const prisma = new PrismaClient();

  try {
    if (args.includes("--evidence")) {
      const evidence = await collectStartEvidence(prisma);
      const missing = missingEvidence(evidence);
      console.log("Start preconditions:");
      console.log(
        `  exact accepted render   ${evidence.exactAcceptedRender ? `proved (slot ${evidence.exactAcceptedRender.scheduledPostId})` : "MISSING"}`,
      );
      console.log(
        `  atomic replacement      ${evidence.atomicReplacement ? `proved (review ${evidence.atomicReplacement.reviewId})` : "MISSING"}`,
      );
      console.log(
        `  sandbox publication     ${evidence.sandboxPublication ? `proved (post ${evidence.sandboxPublication.facebookPostId})` : "MISSING"}`,
      );
      if (missing.length > 0) {
        console.log("\nThe program cannot start yet:");
        for (const item of missing) console.log(`  - ${item}`);
        process.exitCode = 1;
      } else {
        console.log("\nAll three are proved. `npm run program:start` will be accepted.");
      }
      return;
    }

    if (args.includes("--sandbox-proof")) {
      const post = readOption(args, "--post");
      if (!post) throw new EditorialProgramError(USAGE);

      const proof = await verifySandboxProof(prisma, { intendedScheduledPostId: post });
      console.log(`Due rows scanned: ${proof.census.rows.length}`);
      console.log(`AUTOMATIC_PUBLISHING_ENABLED: ${proof.census.globalPublishingEnabled}`);
      console.log(
        `Rows the switch alone is holding back: ${proof.census.switchOnly.length}` +
          (proof.census.switchOnly.length > 0
            ? `\n  ${proof.census.switchOnly.map((row) => row.scheduledPostId).join("\n  ")}`
            : ""),
      );
      for (const row of proof.census.rows) {
        if (row.switchOnly) continue;
        const reason = row.withSwitchOn.eligible ? "already eligible" : row.withSwitchOn.reason;
        console.log(`  other due row ${row.scheduledPostId}: ${reason}`);
      }

      if (!proof.ok) {
        console.error(`\nREFUSED (${proof.reason}): ${proof.detail}`);
        console.error("Do not enable AUTOMATIC_PUBLISHING_ENABLED.");
        process.exitCode = 1;
        return;
      }
      console.log(
        `\nPASSED. Exactly ${post} would publish. You may now enable ` +
          "AUTOMATIC_PUBLISHING_ENABLED for the controlled sandbox call.",
      );
      return;
    }

    if (args.includes("--pause")) {
      const reason = readOption(args, "--reason");
      if (!reason) throw new EditorialProgramError(USAGE);
      const program = await pauseEditorialProgram(prisma, { reason });
      console.log(`Paused at ${program.pausedAt?.toISOString()}. Delivery is paused with it.`);
      console.log("Elapsed days are held exactly where they stand and are never erased.");
      return;
    }

    if (args.includes("--resume")) {
      const program = await resumeEditorialProgram(prisma);
      console.log(
        `Resumed. Banked pause total: ${Math.round(Number(program.pausedMs) / 60_000)} minute(s).`,
      );
      return;
    }

    if (args.includes("--start")) {
      const userId = readOption(args, "--user-id");
      const email = readOption(args, "--email");
      if ((userId === undefined) === (email === undefined)) throw new EditorialProgramError(USAGE);

      const starter = await prisma.user.findFirst({
        where: userId ? { id: userId } : { email },
        select: { id: true, email: true, isPlatformOperator: true },
      });
      if (!starter) throw new EditorialProgramError(`No user matched ${userId ?? email}.`);
      // The phase records who is answerable for it, and that is the platform operator by
      // definition — nobody else reviews across churches.
      if (!starter.isPlatformOperator) {
        throw new EditorialProgramError(
          `${starter.email} does not hold the platform-operator marker. Grant it with ` +
            "`npm run set:platform-operator` first; the human-reference phase records who is " +
            "answerable for every decision in it.",
        );
      }

      const program = await startEditorialProgram(prisma, { startedByUserId: starter.id });
      console.log(
        `Started the fixed ${program.minimumDays}-day human-only phase at ` +
          `${program.startedAt?.toISOString()}, on the authority of ${starter.email}.`,
      );
      console.log("The clock cannot be backdated, restarted, or shortened by early evidence.");
      return;
    }

    console.log(USAGE);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof EditorialProgramError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
