import { PrismaClient } from "@prisma/client";
import { analysisProviderKindSchema } from "@/lib/analysis/routing";
import {
  activateAnalysisRoutingPolicy,
  createAnalysisRoutingPolicyDraft,
} from "@/lib/analysis/routing-store";

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  throw new Error(
    "Usage: npm run set:analysis-routing -- --create-draft --name <label> " +
      "--stage-a-provider <anthropic|google|openai|heuristic> --stage-a-model <model> " +
      "--stage-b-provider <anthropic|google|openai|heuristic> --stage-b-model <model>; or " +
      "npm run set:analysis-routing -- --activate-version <integer>",
  );
}

function assertProviderReady(provider: "anthropic" | "openai" | "google" | "heuristic") {
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required before an Anthropic route can become active.");
  }
  if (provider === "google" && !process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required before a Google route can become active.");
  }
  if (provider === "openai") {
    throw new Error("The OpenAI adapter is not installed yet. The policy was not changed.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const activateVersion = Number(readOption(args, "--activate-version"));
  const createDraft = args.includes("--create-draft");
  const prisma = new PrismaClient();
  if (Number.isInteger(activateVersion) && activateVersion > 0 && !createDraft) {
    try {
      const policy = await prisma.analysisRoutingPolicy.findUniqueOrThrow({
        where: { version: activateVersion },
      });
      assertProviderReady(policy.classificationProvider.toLowerCase() as Parameters<typeof assertProviderReady>[0]);
      assertProviderReady(policy.scoringProvider.toLowerCase() as Parameters<typeof assertProviderReady>[0]);
      const activated = await activateAnalysisRoutingPolicy(prisma, activateVersion);
      console.log(`Activated analysis routing policy ${activated.version} (${activated.id}).`);
      return;
    } finally {
      await prisma.$disconnect();
    }
  }

  const name = readOption(args, "--name");
  const classificationProvider = analysisProviderKindSchema.safeParse(
    readOption(args, "--stage-a-provider"),
  );
  const scoringProvider = analysisProviderKindSchema.safeParse(readOption(args, "--stage-b-provider"));
  const classificationModel = readOption(args, "--stage-a-model");
  const scoringModel = readOption(args, "--stage-b-model");
  if (
    !createDraft ||
    !name ||
    !classificationProvider.success ||
    !scoringProvider.success ||
    !classificationModel ||
    !scoringModel
  ) {
    usage();
  }
  assertProviderReady(classificationProvider.data);
  assertProviderReady(scoringProvider.data);

  try {
    const policy = await createAnalysisRoutingPolicyDraft(prisma, {
      name,
      classification: { provider: classificationProvider.data, model: classificationModel },
      scoring: { provider: scoringProvider.data, model: scoringModel },
    });
    console.log(`Created analysis routing draft ${policy.version} (${policy.id}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
