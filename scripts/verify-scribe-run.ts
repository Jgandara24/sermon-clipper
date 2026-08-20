/**
 * Read-only verification of one transcription run.
 *
 * Reports provider, submitted scope and duration, cost, timestamp bounds, clip count, and
 * editorial exception state — and nothing else. It never selects transcript text, segment text,
 * clip titles, filenames, storage keys, workspace or church names, or any credential, so there
 * is no path by which customer content or a secret can reach the output. Every field it prints
 * is a number, an enum, a boolean, or an id.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/verify-scribe-run.ts --project <projectId>
 *   DATABASE_URL="postgresql://..." npx tsx scripts/verify-scribe-run.ts --source-video <id>
 *
 * Add --json for a machine-readable object instead of the report.
 */

import { PrismaClient } from "@prisma/client";

type Args = { projectId?: string; sourceVideoId?: string; json: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--project") args.projectId = argv[++i];
    else if (argv[i] === "--source-video") args.sourceVideoId = argv[++i];
    else if (argv[i] === "--json") args.json = true;
  }
  if (!args.projectId && !args.sourceVideoId) {
    throw new Error("Pass --project <projectId> or --source-video <sourceVideoId>.");
  }
  return args;
}

function round(value: number | null | undefined, places = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    // Ids and numbers only — no name, filename, or storage key is selected anywhere below.
    const project = args.projectId
      ? await prisma.project.findUnique({
          where: { id: args.projectId },
          select: { id: true, workspaceId: true, sourceVideoId: true, status: true, processingConfig: true },
        })
      : await prisma.project.findFirst({
          where: { sourceVideoId: args.sourceVideoId },
          orderBy: { createdAt: "desc" },
          select: { id: true, workspaceId: true, sourceVideoId: true, status: true, processingConfig: true },
        });

    if (!project?.sourceVideoId) {
      console.error("No project found, or the project has no source video.");
      process.exitCode = 1;
      return;
    }

    const sourceVideo = await prisma.sourceVideo.findUnique({
      where: { id: project.sourceVideoId },
      select: { id: true, durationS: true },
    });
    const sourceDurationS = sourceVideo?.durationS ? Number(sourceVideo.durationS) : null;

    const transcript = await prisma.transcript.findUnique({
      where: { sourceVideoId: project.sourceVideoId },
      select: {
        id: true,
        provider: true,
        language: true,
        createdAt: true,
        // Counts and bounds only. `text` and `words` content are never selected.
        segments: {
          select: { startMs: true, endMs: true, words: true },
          orderBy: { idx: "asc" },
        },
      },
    });

    // Timestamp bounds, and whether they sit inside the real media. A transcript produced from a
    // narrower submitted window that was not offset back would show a maximum far below the
    // source duration, or word bounds outside their own segment.
    let bounds: Record<string, unknown> = { hasTranscript: false };
    if (transcript) {
      const segStart = Math.min(...transcript.segments.map((s) => s.startMs));
      const segEnd = Math.max(...transcript.segments.map((s) => s.endMs));
      let wordStart = Number.POSITIVE_INFINITY;
      let wordEnd = Number.NEGATIVE_INFINITY;
      let wordCount = 0;
      let nonMonotonic = 0;
      for (const segment of transcript.segments) {
        const words = Array.isArray(segment.words) ? (segment.words as Array<Record<string, unknown>>) : [];
        let previousStart = -1;
        for (const word of words) {
          const start = typeof word.startMs === "number" ? word.startMs : null;
          const end = typeof word.endMs === "number" ? word.endMs : null;
          if (start === null || end === null) continue;
          wordCount += 1;
          if (start < wordStart) wordStart = start;
          if (end > wordEnd) wordEnd = end;
          if (start < previousStart) nonMonotonic += 1;
          previousStart = start;
        }
      }
      const sourceDurationMs = sourceDurationS === null ? null : Math.round(sourceDurationS * 1000);
      bounds = {
        hasTranscript: true,
        segmentCount: transcript.segments.length,
        wordCount,
        segmentStartMs: segStart,
        segmentEndMs: segEnd,
        wordStartMs: Number.isFinite(wordStart) ? wordStart : null,
        wordEndMs: Number.isFinite(wordEnd) ? wordEnd : null,
        sourceDurationMs,
        withinSourceBounds:
          sourceDurationMs === null ? null : segStart >= 0 && segEnd <= sourceDurationMs + 1000,
        // A transcript that covers only the opening minutes of a long source is the signature of
        // a submitted window that was never offset back onto the source timeline.
        coverageRatio:
          sourceDurationMs && sourceDurationMs > 0 ? round(segEnd / sourceDurationMs, 3) : null,
        nonMonotonicWordStarts: nonMonotonic,
      };
    }

    // Cost facts are OperationalEvent rows; the fact itself lives in metadata.
    const costEvents = await prisma.operationalEvent.findMany({
      where: { projectId: project.id, eventType: "processing_cost_fact" },
      select: { id: true, createdAt: true, metadata: true },
      orderBy: { createdAt: "asc" },
    });
    const transcription = costEvents
      .map((event) => (event.metadata ?? {}) as Record<string, unknown>)
      .filter((fact) => fact.stage === "transcription")
      .map((fact) => ({
        provider: fact.provider,
        model: fact.model,
        outcome: fact.outcome,
        attempt: fact.attempt,
        quantity: round(fact.quantity as number),
        unit: fact.unit,
        unitCostUsd: round(fact.unitCostUsd as number, 6),
        totalCostUsd: round(fact.totalCostUsd as number, 6),
        pricingStatus: fact.pricingStatus,
        submittedDurationS: (fact.details as Record<string, unknown> | undefined)?.submittedDurationS ?? null,
        submittedScope: (fact.details as Record<string, unknown> | undefined)?.submittedScope ?? null,
        keytermsCount: (fact.details as Record<string, unknown> | undefined)?.keytermsCount ?? null,
      }));

    // Event types only — messages are not selected, so no free text can escape.
    const transcriptionEvents = await prisma.operationalEvent.groupBy({
      by: ["eventType", "severity"],
      where: {
        projectId: project.id,
        category: { in: ["transcription", "facebook_publish"] },
      },
      _count: { _all: true },
    });

    const exceptions = await prisma.editorialException.findMany({
      where: { projectId: project.id },
      select: {
        id: true,
        exceptionType: true,
        state: true,
        createdAt: true,
        resolvedAt: true,
        resolutionReason: true,
        metadata: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const clipCount = await prisma.generatedClip.count({ where: { projectId: project.id } });
    const editCount = await prisma.clipEdit.count({ where: { clip: { projectId: project.id } } });
    const approvalCount = await prisma.clipApproval.count({ where: { clip: { projectId: project.id } } });
    const exportCount = await prisma.exportJob.count({ where: { clip: { projectId: project.id } } });

    const report = {
      projectId: project.id,
      sourceVideoId: project.sourceVideoId,
      projectStatus: project.status,
      sermonRangeConfigured: Boolean(
        project.processingConfig &&
          typeof project.processingConfig === "object" &&
          !Array.isArray(project.processingConfig) &&
          (project.processingConfig as Record<string, unknown>).sermonRange,
      ),
      provider: transcript?.provider ?? null,
      language: transcript?.language ?? null,
      transcribedAt: transcript?.createdAt.toISOString() ?? null,
      timestamps: bounds,
      transcriptionCostFacts: transcription,
      totalTranscriptionCostUsd: round(
        transcription.reduce((sum, fact) => sum + (fact.totalCostUsd ?? 0), 0),
        6,
      ),
      clipCount,
      humanWorkOnClips: { edits: editCount, approvals: approvalCount, exports: exportCount },
      editorialExceptions: exceptions.map((exception) => ({
        id: exception.id,
        exceptionType: exception.exceptionType,
        state: exception.state,
        createdAt: exception.createdAt.toISOString(),
        resolvedAt: exception.resolvedAt?.toISOString() ?? null,
        // The reason is written by us and names providers only; it never contains church content.
        resolutionReason: exception.resolutionReason,
        metadata: exception.metadata,
      })),
      eventCounts: transcriptionEvents.map((row) => ({
        eventType: row.eventType,
        severity: row.severity,
        count: row._count._all,
      })),
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log("=== Transcription run verification (read-only) ===");
    console.log(`project            ${report.projectId}  [${report.projectStatus}]`);
    console.log(`source video       ${report.sourceVideoId}`);
    console.log(`provider           ${report.provider ?? "(no transcript)"}`);
    console.log(`transcribed at     ${report.transcribedAt ?? "-"}`);
    console.log(`sermon range set   ${report.sermonRangeConfigured}`);
    console.log("");
    console.log("-- submitted window and cost --");
    if (transcription.length === 0) console.log("  (no transcription cost fact)");
    for (const fact of transcription) {
      console.log(
        `  ${fact.provider}/${fact.model} attempt ${fact.attempt} ${fact.outcome}: ` +
          `scope=${fact.submittedScope} submittedDurationS=${fact.submittedDurationS} ` +
          `qty=${fact.quantity}${fact.unit} unit=$${fact.unitCostUsd} total=$${fact.totalCostUsd} ` +
          `(${fact.pricingStatus}, keyterms=${fact.keytermsCount})`,
      );
    }
    console.log(`  total transcription cost: $${report.totalTranscriptionCostUsd}`);
    console.log("");
    console.log("-- timestamp bounds --");
    console.log(`  ${JSON.stringify(report.timestamps)}`);
    console.log("");
    console.log("-- clips and human work --");
    console.log(`  clips=${clipCount} edits=${editCount} approvals=${approvalCount} exports=${exportCount}`);
    console.log("");
    console.log("-- editorial exceptions --");
    if (exceptions.length === 0) console.log("  none");
    for (const exception of report.editorialExceptions) {
      console.log(
        `  ${exception.exceptionType} [${exception.state}] opened ${exception.createdAt}` +
          (exception.resolvedAt ? ` resolved ${exception.resolvedAt}` : "") +
          `\n     metadata: ${JSON.stringify(exception.metadata)}` +
          (exception.resolutionReason ? `\n     reason: ${exception.resolutionReason}` : ""),
      );
    }
    console.log("");
    console.log("-- event counts --");
    for (const row of report.eventCounts) {
      console.log(`  ${row.eventType} [${row.severity}] x${row.count}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
