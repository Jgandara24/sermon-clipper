import { PrismaClient } from "@prisma/client";
import {
  listPlatformOperators,
  PlatformOperatorInputError,
  setPlatformOperator,
} from "@/lib/operations/platform-operator";

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usageError(): PlatformOperatorInputError {
  return new PlatformOperatorInputError(
    "Usage: npm run set:platform-operator -- (--user-id <uuid> | --email <address>) (--grant | --revoke)\n" +
      "       npm run set:platform-operator -- --list",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const prisma = new PrismaClient();

  try {
    if (args.includes("--list")) {
      const operators = await listPlatformOperators(prisma);
      if (operators.length === 0) {
        console.log("No user holds the platform-operator marker.");
        return;
      }
      console.log(`${operators.length} platform operator(s):`);
      for (const operator of operators) {
        const granted = operator.platformOperatorGrantedAt?.toISOString() ?? "unknown";
        console.log(`  ${operator.email}  (${operator.id})  granted ${granted}`);
      }
      return;
    }

    const userId = readOption(args, "--user-id");
    const email = readOption(args, "--email");
    const grant = args.includes("--grant");
    const revoke = args.includes("--revoke");

    if (grant === revoke) throw usageError();
    if ((userId === undefined) === (email === undefined)) throw usageError();

    const change = await setPlatformOperator(prisma, {
      userId,
      email,
      isPlatformOperator: grant,
    });

    if (!change.changed) {
      console.log(
        `${change.email} already ${grant ? "holds" : "does not hold"} the platform-operator marker. Nothing changed.`,
      );
      return;
    }

    console.log(
      grant
        ? `Granted platform-operator authority to ${change.email} (${change.userId}).`
        : `Revoked platform-operator authority from ${change.email} (${change.userId}).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
