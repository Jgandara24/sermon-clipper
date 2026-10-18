import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { readSandboxServiceArgs } from "@/lib/operations/sandbox-service-input";
import { applySandboxService, planSandboxService, sandboxServicePlanSchema,
  SandboxServiceRefused } from "@/lib/operations/sandbox-service";
import { PlatformOperatorAuthorizationError } from "@/lib/operator-auth";

const USAGE = `Usage:
  npm run prepare:sandbox-service -- --operator <uuid> --import-user <uuid> \\
    --workspace <uuid> --source-video <uuid> --name <name> --date YYYY-MM-DD \\
    --occurrence PRIMARY|SECONDARY|UNMATCHED

  Read-only by default. Save the printed plan JSON to a private file.
  After review, repeat the arguments and add:
    --apply --plan <file> --queue-finalize --confirm <plan-token> \\
    --confirm-sandbox <same-workspace-uuid>

  Apply creates one service and queues one FINALIZE job. It does not start a worker,
  process media, render, publish, deploy, or change settings.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(USAGE); return; }
  const input = readSandboxServiceArgs(args), prisma = new PrismaClient();
  try {
    if (!input.apply) {
      const result = await planSandboxService(prisma, input);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const file = JSON.parse(await readFile(input.planPath!, "utf8")) as { plan?: unknown };
    const plan = sandboxServicePlanSchema.parse(file.plan ?? file);
    const expected = { operatorId: input.operatorId, importUserId: input.importUserId,
      workspaceId: input.workspaceId, sourceVideoId: input.sourceVideoId, name: input.name,
      sermonDate: input.sermonDate, occurrence: input.occurrence };
    if (JSON.stringify(plan.input) !== JSON.stringify(expected)) throw new SandboxServiceRefused("PLAN_ARGUMENT_MISMATCH");
    const result = await applySandboxService(prisma, plan, input.confirmation!, input.confirmedSandboxWorkspaceId!);
    console.log(JSON.stringify(result, null, 2));
    console.log("One sandbox service and one queued FINALIZE job are present. No worker was started.");
  } finally { await prisma.$disconnect(); }
}

main().catch((error: unknown) => {
  if (error instanceof SandboxServiceRefused) console.error(`REFUSED (${error.code}).`);
  else if (error instanceof PlatformOperatorAuthorizationError) console.error(error.message);
  else if (error instanceof ZodError || error instanceof SyntaxError) console.error(`Invalid input.\n${USAGE}`);
  else console.error("Sandbox service preparation failed. Check private runtime diagnostics.");
  process.exitCode = 1;
});
