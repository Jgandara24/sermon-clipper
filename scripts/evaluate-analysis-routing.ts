import { PrismaClient } from "@prisma/client";
import { getAnalysisProvider } from "@/lib/analysis";
import { buildCandidateWindows } from "@/lib/analysis/chunking";
import { loadAnalysisRoutingPolicyForEvaluation } from "@/lib/analysis/routing-store";
import { filterSermonCandidates } from "@/lib/analysis/sermon-boundary";
import { buildRoutingEvaluationReport } from "@/lib/evaluation/routing-evaluation";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const projectId = option(args, "--project-id");
  const policyVersion = Number(option(args, "--policy-version"));
  if (!projectId || !Number.isInteger(policyVersion) || policyVersion < 1) {
    throw new Error(
      "Usage: npm run evaluate:analysis-routing -- --project-id <uuid> --policy-version <integer>",
    );
  }

  const prisma = new PrismaClient();
  try {
    const startedAt = new Date();
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: {
        sourceVideo: {
          include: { transcript: { include: { segments: { orderBy: { idx: "asc" } } } } },
        },
      },
    });
    const transcript = project.sourceVideo?.transcript;
    if (!transcript?.segments.length) throw new Error("The project has no transcript segments.");
    const segments = transcript.segments.map((segment) => ({
      idx: segment.idx,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    }));
    const allCandidates = buildCandidateWindows(segments, { minMs: 20_000, maxMs: 90_000 });
    const config = project.processingConfig as Record<string, unknown>;
    const genre = typeof config.genre === "string" ? config.genre : "sermon";
    const candidates =
      genre.toLowerCase() === "sermon"
        ? filterSermonCandidates(allCandidates)
        : allCandidates;
    const resolved = await loadAnalysisRoutingPolicyForEvaluation(prisma, policyVersion, startedAt);
    const selection = await getAnalysisProvider(resolved);
    if (selection.selectionReason !== "master_policy") {
      throw new Error(
        `The policy's providers are not available here (selection: ${selection.selectionReason}). ` +
          "Set the provider API keys first — a shadow report must not silently fall back to the heuristic scorer.",
      );
    }
    const runStartedAt = Date.now();
    const scored = await selection.provider.scoreCandidates(candidates, {
      fullText: transcript.fullText,
      genre,
    });
    const sourceDurationMs = project.sourceVideo?.durationS
      ? project.sourceVideo.durationS.toNumber() * 1000
      : Math.max(...segments.map((segment) => segment.endMs));
    const report = buildRoutingEvaluationReport({
      projectId,
      sourceDurationMs,
      candidateCount: candidates.length,
      scored,
      routing: resolved.routing,
      usage: selection.provider.lastUsage ?? null,
      wallTimeMs: Date.now() - runStartedAt,
      startedAt,
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
