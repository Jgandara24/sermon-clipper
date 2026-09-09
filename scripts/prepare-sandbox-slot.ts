import { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { PlatformOperatorAuthorizationError } from "@/lib/operator-auth";
import { readSandboxSlotArgs } from "@/lib/operations/sandbox-slot-input";
import { prepareSandboxSlot, SandboxSlotRefusedError } from "@/lib/operations/sandbox-slot";

const USAGE = `Usage:
  npm run prepare:sandbox-slot -- --operator <user-uuid> --workspace <workspace-uuid> \\
    --project <project-uuid> --clip <clip-uuid> --date YYYY-MM-DD

  Read-only by default. Verify the printed workspace is the intended sandbox.
  After separate approval, repeat those arguments and add:
    --apply --confirm <plan-token> --confirm-sandbox <same-workspace-uuid>

  Apply creates one slot and a staff audit event. It can extend an existing source
  expiry. It does not create jobs, render, publish, accept a clip, or change settings.
  Run with the confirmed worker environment. Local flags do not prove other workers
  are off. This command does not verify Meta Page identity or caption accuracy.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(USAGE);
    return;
  }
  const input = readSandboxSlotArgs(args);
  const prisma = new PrismaClient();
  try {
    const result = await prepareSandboxSlot(prisma, input);
    console.log(JSON.stringify(result, null, 2));
    console.log(result.applied
      ? "One test slot was created. Rendering and human review are separate steps."
      : "READ ONLY. No rows changed. Review this plan before a separately approved apply.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof SandboxSlotRefusedError) console.error(`REFUSED (${error.code}): ${error.message}`);
  else if (error instanceof PlatformOperatorAuthorizationError) console.error(error.message);
  else if (error instanceof ZodError) console.error(`Invalid input.\n${USAGE}`);
  // Never print Prisma/provider errors: these can contain connection strings or storage keys.
  else console.error("Sandbox slot preparation failed. Check the command arguments and private runtime diagnostics.");
  process.exitCode = 1;
});
