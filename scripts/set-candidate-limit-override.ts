import { PrismaClient } from "@prisma/client";
import {
  CandidateLimitOverrideInputError,
  setCandidateLimitOverride,
} from "@/lib/operations/candidate-limit-override";

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usageError(): CandidateLimitOverrideInputError {
  return new CandidateLimitOverrideInputError(
    "Usage: npm run set:candidate-limit-override -- --workspace-id <uuid> (--value <integer> | --clear)",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const workspaceId = readOption(args, "--workspace-id");
  const rawValue = readOption(args, "--value");
  const clear = args.includes("--clear");

  if (!workspaceId || clear === (rawValue !== undefined)) {
    throw usageError();
  }

  const candidateLimitOverride = clear ? null : Number(rawValue);
  const prisma = new PrismaClient();
  try {
    await setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride });
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    clear
      ? `Cleared the candidate limit override for workspace ${workspaceId}.`
      : `Set the candidate limit override to ${candidateLimitOverride} for workspace ${workspaceId}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
