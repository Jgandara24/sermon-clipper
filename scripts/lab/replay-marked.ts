/**
 * Phase 1 lab: replay one fix over every clip Jake has marked (evaluation/lab-labels/*.json) and
 * show what moves. The gate for a fix: it should change the clips he failed for that reason and
 * leave the clips he passed where they are.
 *
 *   npm run lab:replay -- --fix U [--only "Lab 1n"] [--concurrency 4] [--out replay.json]
 *
 * Each clip is replayed as Jake saw it: the marked start and end, the project's transcript, and the
 * sermon span the lab run saved for that project. Fix U calls the scoring model once per clip, and
 * again for a clip it restarts later in its story. Reads the lab database only. Writes nothing to it.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { PrismaClient } from "@prisma/client";
import {
  boundaryContext,
  BoundaryChoiceSchema,
  checkStory,
  endLookLines,
  EndLookSchema,
  endsInsideParallelBlock,
  endsOnRecapIntoNextPoint,
  lookPastTheEnd,
  readsVerse,
  StoryCheckSchema,
  type BoundaryTurn,
  type BoundaryUnit,
  type StoryCheck,
} from "@/lib/analysis/boundary-step";
import { checkClipCamera } from "@/lib/analysis/camera-check-run";
import { scoringModel } from "@/lib/analysis/claude-provider";
import { snapClipEnd } from "@/lib/analysis/end-silence";
import { assertLabEnvironment, formatClock, LabEnvironmentError, readArgs } from "./lab-guard";

type LabelFile = {
  projectId: string;
  projectName: string;
  clips: Record<string, { rank: number; startMs: number; endMs: number; verdict: "pass" | "fail"; failedTests: number[]; note: string }>;
};

type MarkedClip = {
  sermon: string;
  projectId: string;
  clipId: string;
  rank: number;
  verdict: "pass" | "fail";
  failedTests: number[];
  note: string;
  startMs: number;
  endMs: number;
};

export type ReplayRow = MarkedClip & {
  to: [number, number] | null;
  moved: boolean;
  detail: Record<string, unknown>;
};

const FIXES = ["U", "V", "T", "W", "X", "Y"] as const;
type Fix = (typeof FIXES)[number];
/** Fix X: ask the end look (fix M) again on every clip it shows lines for; a control for the look's model variance. */
let REASK = false;

async function main() {
  const args = readArgs(process.argv.slice(2));
  const fixArg = args.get("fix");
  if (typeof fixArg !== "string" || !(FIXES as readonly string[]).includes(fixArg)) {
    console.error(`Usage: npm run lab:replay -- --fix ${FIXES.join("|")} [--only "Lab 1n"] [--concurrency 4] [--out replay.json] [--reask]`);
    process.exit(2);
  }
  const fix = fixArg as Fix;
  const only = typeof args.get("only") === "string" ? (args.get("only") as string) : null;
  REASK = args.get("reask") === true;
  const concurrency = typeof args.get("concurrency") === "string" ? Number(args.get("concurrency")) : 4;
  const out = typeof args.get("out") === "string" ? (args.get("out") as string) : path.join(os.tmpdir(), `lab-replay-${fix}-${Date.now()}.json`);

  assertLabEnvironment({ requireAnthropicKey: fix === "U" || fix === "X" || fix === "Y" });

  const prisma = new PrismaClient();
  const usage = { input: 0, output: 0, calls: 0 };
  try {
    const labelsDir = path.resolve("evaluation/lab-labels");
    const files = (await readdir(labelsDir)).filter((f) => f.endsWith(".json"));
    const marked: MarkedClip[] = [];
    const projects = new Map<string, { segments: BoundaryUnit[]; span: { startMs: number; endMs: number } | null; source: string | null }>();
    const storageRoot = path.resolve(process.env.STORAGE_LOCAL_ROOT ?? ".data/storage");
    for (const file of files) {
      const label = JSON.parse(await readFile(path.join(labelsDir, file), "utf8")) as LabelFile;
      const sermon = label.projectName.split(" - ")[0];
      if (only && !label.projectName.startsWith(only)) continue;
      if (Object.keys(label.clips).length === 0) continue;
      const project = await prisma.project.findUnique({
        where: { id: label.projectId },
        include: { sourceVideo: { include: { transcript: { include: { segments: { orderBy: { idx: "asc" } } } } } } },
      });
      const segments = project?.sourceVideo?.transcript?.segments;
      if (!segments) {
        console.error(`Skipping ${label.projectName}: no transcript in the lab database.`);
        continue;
      }
      const steps = await prisma.operationalEvent.findFirst({
        where: { projectId: label.projectId, eventType: "lab_selection_steps" },
        orderBy: { createdAt: "desc" },
      });
      const span = ((steps?.metadata as { sermonSpan?: { span?: { startMs: number; endMs: number } | null } } | null)?.sermonSpan?.span ?? null);
      // Fixes V and Y read the recording. A project's own source file, or another lab copy of the same video.
      let source: string | null = null;
      if (fix === "V" || fix === "Y") {
        const originUrl = project.sourceVideo?.originUrl ?? null;
        const others = originUrl ? await prisma.sourceVideo.findMany({ where: { originUrl }, select: { storageKey: true } }) : [];
        const keys = [project.sourceVideo?.storageKey ?? null, ...others.map((s) => s.storageKey)];
        source = keys.map((k) => (k ? path.join(storageRoot, k) : null)).find((p): p is string => Boolean(p) && existsSync(p!)) ?? null;
        if (!source) console.error(`${label.projectName}: no source file on disk, so fix ${fix} cannot replay its clips.`);
      }
      projects.set(label.projectId, {
        segments: segments.map((s) => ({ idx: s.idx, startMs: s.startMs, endMs: s.endMs, text: s.text })),
        span,
        source,
      });
      for (const [clipId, clip] of Object.entries(label.clips)) {
        marked.push({ sermon, projectId: label.projectId, clipId, ...clip });
      }
    }
    marked.sort((a, b) => a.sermon.localeCompare(b.sermon) || a.rank - b.rank);
    console.log(`${marked.length} marked clips in ${projects.size} projects. Replaying fix ${fix} with ${concurrency} at a time.\n`);

    const rows: ReplayRow[] = [];
    let next = 0;
    const worker = async () => {
      while (next < marked.length) {
        const clip = marked[next++];
        const { segments, span, source } = projects.get(clip.projectId)!;
        const sermonSegments = span ? segments.filter((s) => s.startMs >= span.startMs && s.endMs <= span.endMs) : segments;
        try {
          const row = await replayOne(fix, clip, sermonSegments, usage, source);
          rows.push(row);
          const mark = row.moved ? "MOVED" : "same ";
          console.log(
            `${mark}  ${clip.sermon.padEnd(8)} clip ${clip.rank} ${clip.verdict.toUpperCase().padEnd(4)}  ${formatClock(clip.startMs)}-${formatClock(clip.endMs)}` +
              (row.moved && row.to ? ` -> ${formatClock(row.to[0])}-${formatClock(row.to[1])}` : "") +
              (row.detail.outcome ? `  ${String(row.detail.outcome)}` : "") +
              (typeof row.detail.movedMs === "number" ? ` (${row.detail.movedMs} ms)` : "") +
              (row.detail.refused ? `  refused: ${String(row.detail.refused).slice(0, 90)}` : ""),
          );
        } catch (error) {
          rows.push({ ...clip, to: null, moved: false, detail: { error: String(error) } });
          console.log(`ERROR  ${clip.sermon} clip ${clip.rank}: ${String(error).slice(0, 200)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

    rows.sort((a, b) => a.sermon.localeCompare(b.sermon) || a.rank - b.rank);
    const moved = rows.filter((r) => r.moved);
    const passMoved = moved.filter((r) => r.verdict === "pass");
    const failMoved = moved.filter((r) => r.verdict === "fail");
    const pass = rows.filter((r) => r.verdict === "pass").length;
    const fail = rows.filter((r) => r.verdict === "fail").length;
    console.log(`\nFix ${fix}: ${moved.length} of ${rows.length} clips move. Passed: ${passMoved.length} of ${pass} move. Failed: ${failMoved.length} of ${fail} move.`);
    if (fix === "U") {
      const by = (key: string) => rows.filter((r) => r.detail.outcome === key).length;
      console.log(`Story check: ${by("extended")} extended, ${by("restarted")} restarted, ${by("unresolved")} unresolved (story goes on, no landing found).`);
      console.log(`Model calls: ${usage.calls}, ${usage.input} input tokens, ${usage.output} output tokens.`);
    }
    if (fix === "X") {
      const verse = rows.filter((r) => r.detail.verseEnd).length;
      const asked = rows.filter((r) => r.detail.reask).length;
      const lookMoved = rows.filter((r) => typeof r.detail.movedMs === "number").length;
      console.log(`Verse ends refused: ${verse}.` + (REASK ? ` The end look was asked again on ${asked} clips and moved ${lookMoved}.` : ""));
      console.log(`Model calls: ${usage.calls}, ${usage.input} input tokens, ${usage.output} output tokens.`);
    }
    if (fix === "Y") {
      const slides = rows.filter((r) => String(r.detail.outcome ?? "").startsWith("slide")).length;
      const unchecked = rows.filter((r) => String(r.detail.outcome ?? "").startsWith("unchecked")).length;
      const sceneFrames = rows.reduce((n, r) => n + Number(r.detail.sceneFrames ?? 0), 0);
      const frames = rows.reduce((n, r) => n + Number(r.detail.frames ?? 0), 0);
      console.log(`Slides found: ${slides}; unchecked: ${unchecked}. Frames shown: ${frames}, of them ${sceneFrames} at scene changes. Vision calls: ${usage.calls}, ${usage.input} input tokens.`);
    }
    if (fix === "W") {
      const joined = rows.filter((r) => r.detail.ellipsisJoined).length;
      console.log(`The "..." fix: ${joined} marked clips end on a sentence that now runs on through a "..." segment.`);
    }
    if (fix === "V" && moved.length > 0) {
      const sizes = moved.map((r) => Math.abs(Number(r.detail.movedMs)));
      console.log(`Cut moves: ${Math.min(...sizes)} to ${Math.max(...sizes)} ms back into the pause.`);
    }
    if (moved.length > 0) {
      console.log("\nMoved clips:");
      for (const r of moved) {
        console.log(
          `  ${r.sermon.padEnd(8)} clip ${r.rank} ${r.verdict.toUpperCase().padEnd(4)} tests=${JSON.stringify(r.failedTests)}  ` +
            `${formatClock(r.startMs)}-${formatClock(r.endMs)} -> ${r.to ? `${formatClock(r.to[0])}-${formatClock(r.to[1])}` : "null"}  ${String(r.detail.outcome ?? "")}` +
            (r.note ? `\n           Jake: ${r.note.trim().slice(0, 160)}` : "") +
            (r.detail.reason ? `\n           model: ${String(r.detail.reason).slice(0, 200)}` : ""),
        );
      }
    }
    await writeFile(out, JSON.stringify({ fix, replayedAt: new Date().toISOString(), usage, rows }, null, 2));
    console.log(`\nSaved: ${out}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function replayOne(
  fix: Fix,
  clip: MarkedClip,
  segments: BoundaryUnit[],
  usage: { input: number; output: number; calls: number },
  source: string | null,
): Promise<ReplayRow> {
  const range = { startMs: clip.startMs, endMs: clip.endMs };
  if (fix === "Y") {
    if (!source) return { ...clip, to: null, moved: false, detail: { error: "no source file on disk" } };
    const { result, usage: used } = await checkClipCamera({
      sourceFilePath: source,
      startMs: range.startMs,
      endMs: range.endMs,
      workDir: path.join(os.tmpdir(), "lab-replay-camera"),
    });
    if (used.frames > 0) usage.calls += 1;
    usage.input += used.inputTokens;
    usage.output += used.outputTokens;
    const detail: Record<string, unknown> = { frames: used.frames, sceneFrames: used.sceneFrames };
    if (result.pass) return { ...clip, to: null, moved: false, detail };
    return {
      ...clip,
      to: null,
      moved: true,
      detail: {
        ...detail,
        outcome: result.via ? `${result.reason} (${result.via})` : result.reason,
        at: result.at,
        reason: `${result.reason} at ${formatClock(Math.round(result.at * 1000))}, ${((result.at * 1000 - range.startMs) / 1000).toFixed(1)} s into the clip${result.via ? `, via ${result.via}` : ""}`,
      },
    };
  }
  if (fix === "V") {
    if (!source) return { ...clip, to: null, moved: false, detail: { error: "no source file on disk" } };
    const snapped = await snapClipEnd(source, range);
    return snapped
      ? { ...clip, to: [range.startMs, snapped.endMs], moved: true, detail: { outcome: "snapped", movedMs: snapped.movedMs } }
      : { ...clip, to: null, moved: false, detail: {} };
  }
  const context = boundaryContext(segments, range);
  if (fix === "W") {
    const { units, currentStart, currentEnd } = context;
    // The "..." fix: a marked end whose sentence now runs on through a "..." segment.
    const ellipsisJoined = /\s\.\.\.\s/.test(units[currentEnd].text);
    const block = currentEnd > currentStart ? endsInsideParallelBlock(units, currentEnd) : null;
    if (!block) return { ...clip, to: null, moved: false, detail: ellipsisJoined ? { ellipsisJoined } : {} };
    const endMs = units[block.last].endMs;
    return {
      ...clip,
      to: [range.startMs, endMs],
      moved: true,
      detail: {
        outcome: endMs - range.startMs > 90_000 ? "block end, over 90 s" : "block end",
        movedMs: endMs - range.endMs,
        openings: block.openings,
        reason: `parallel lines open with ${block.openings.map((o) => `"${o}"`).join(", ")}; the block ends on "${units[block.last].text.slice(0, 80)}"`,
        ellipsisJoined,
      },
    };
  }
  if (fix === "X") {
    const { units, currentStart, currentEnd } = context;
    const verseEnd = currentEnd > currentStart && readsVerse(units, currentEnd);
    const reask = REASK && endLookLines(units, range) !== null;
    if (!verseEnd && !reask) return { ...clip, to: null, moved: false, detail: {} };
    const detail: Record<string, unknown> = { verseEnd, reask };
    if (verseEnd) {
      detail.outcome = "verse end refused";
      detail.reason = units[currentEnd].text.slice(0, 120);
    }
    if (reask) {
      const client = new Anthropic();
      const looked = await lookPastTheEnd(units, range, async (prompt) => {
        const message = await client.messages.create({
          model: scoringModel(),
          max_tokens: 600,
          thinking: { type: "disabled" },
          messages: [{ role: "user", content: prompt }],
          output_config: { format: zodOutputFormat(EndLookSchema) },
        });
        usage.calls += 1;
        usage.input += message.usage.input_tokens;
        usage.output += message.usage.output_tokens;
        const block = message.content.find((b) => b.type === "text");
        return EndLookSchema.parse(JSON.parse(block && block.type === "text" ? block.text : "null"));
      });
      detail.look = looked.look;
      if (looked.range.endMs !== range.endMs) {
        detail.outcome = `${verseEnd ? "verse end refused; " : ""}end look moved`;
        detail.movedMs = looked.range.endMs - range.endMs;
        detail.reason = looked.look.reason;
        return { ...clip, to: [range.startMs, looked.range.endMs], moved: true, detail };
      }
    }
    return { ...clip, to: null, moved: verseEnd, detail };
  }
  if (fix === "T") {
    const { units, currentStart, currentEnd } = context;
    if (currentEnd > currentStart && endsOnRecapIntoNextPoint(units, currentEnd)) {
      const endMs = units[currentEnd - 1].endMs;
      return {
        ...clip,
        to: [range.startMs, endMs],
        moved: true,
        detail: { outcome: "recap dropped", movedMs: endMs - range.endMs, dropped: units[currentEnd].text, next: units[currentEnd + 1]?.text },
      };
    }
    return { ...clip, to: null, moved: false, detail: {} };
  }
  if (fix === "U") {
    const client = new Anthropic();
    const askStory = async (prompt: string) => {
      const message = await client.messages.create({
        model: scoringModel(),
        max_tokens: 600,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: prompt }],
        output_config: { format: zodOutputFormat(StoryCheckSchema) },
      });
      usage.calls += 1;
      usage.input += message.usage.input_tokens;
      usage.output += message.usage.output_tokens;
      const block = message.content.find((b) => b.type === "text");
      return StoryCheckSchema.parse(JSON.parse(block && block.type === "text" ? block.text : "null"));
    };
    const askBoundary = async (turns: BoundaryTurn[]) => {
      const message = await client.messages.create({
        model: scoringModel(),
        max_tokens: 1000,
        thinking: { type: "disabled" },
        messages: turns,
        output_config: { format: zodOutputFormat(BoundaryChoiceSchema) },
      });
      usage.calls += 1;
      usage.input += message.usage.input_tokens;
      usage.output += message.usage.output_tokens;
      const block = message.content.find((b) => b.type === "text");
      return BoundaryChoiceSchema.parse(JSON.parse(block && block.type === "text" ? block.text : "null"));
    };
    const checked = await checkStory(context, range, askStory, askBoundary);
    const moved = checked.range.startMs !== range.startMs || checked.range.endMs !== range.endMs;
    const detail: Record<string, unknown> = { ...(checked.check as StoryCheck) };
    if (checked.attempts) detail.attempts = checked.attempts;
    return { ...clip, to: moved ? [checked.range.startMs, checked.range.endMs] : null, moved, detail };
  }
  throw new Error(`Fix ${fix} has no replay yet.`);
}

main().catch((error) => {
  if (error instanceof LabEnvironmentError) {
    console.error(`\nStopped: ${error.message}`);
    process.exit(1);
  }
  throw error;
});
