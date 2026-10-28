/**
 * Phase 1 lab: replay one fix over every clip Jake has marked (evaluation/lab-labels/*.json) and
 * show what moves. The gate for a fix: it should change the clips he failed for that reason and
 * leave the clips he passed where they are.
 *
 *   npm run lab:replay -- --fix U [--only "Lab 1n"] [--concurrency 4] [--out replay.json]
 *
 * Fixes AA, AD and AE are code rules replayed on the marked range (no model); AB is fix U's story check
 * with the cut; AC samples the recording and runs the person detector, no vision model.
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
  BOUNDARY_CUT_MAX_MS,
  BOUNDARY_MAX_MS,
  BOUNDARY_MIN_MS,
  boundaryContext,
  BoundaryChoiceSchema,
  boundaryPrompt,
  checkStory,
  chooseBoundary,
  endBeforeNextPoint,
  endLookLines,
  endLookPrompt,
  EndLookSchema,
  endsInsideParallelBlock,
  backReferenceStart,
  labelStart,
  lookPastTheEnd,
  readsVerse,
  recapIntoNextPoint,
  sectionBreakInside,
  StoryCheckSchema,
  type BoundaryContext,
  type BoundaryLimits,
  type BoundaryTurn,
  type BoundaryUnit,
  type HeldEnd,
  type StoryCheck,
} from "@/lib/analysis/boundary-step";
import { checkClipCamera, checkClipEmptyFrames } from "@/lib/analysis/camera-check-run";
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
  /** Fix AE: the end before the end look (fix M) moved it, from the stored steps; the marked end when it did not. */
  preLookEndMs?: number;
};

export type ReplayRow = MarkedClip & {
  to: [number, number] | null;
  moved: boolean;
  detail: Record<string, unknown>;
};

const FIXES = ["U", "V", "T", "W", "X", "Y", "Z", "AA", "AB", "AC", "AD", "AE", "AG"] as const;
type Fix = (typeof FIXES)[number];
/** Fix X: ask the end look (fix M) again on every clip it shows lines for; a control for the look's model variance. */
let REASK = false;
/** Fix Z: run the boundary step and the end look with the prompts as they were before the fix. */
let CONTROL = false;

/**
 * Fix Z's control prompts: the new prompt with each changed sentence put back. Each swap must apply, or
 * the control is not the prompt that ran before.
 */
function swap(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`Control prompt: the text "${from.slice(0, 50)}…" is not in the prompt any more.`);
  return text.replace(from, to);
}
const HOOK_RULES = /- Start on the hook: the first line that would stop a viewer scrolling\.[\s\S]*?start on the hook, not on the announcement\.\n/;
function classicBoundaryPrompt(context: BoundaryContext, hold: HeldEnd | null): string {
  let text = boundaryPrompt(context, hold);
  if (!HOOK_RULES.test(text)) throw new Error("Control prompt: the hook rules are not in the prompt any more.");
  text = text.replace(
    HOOK_RULES,
    "- Start where the thought starts: the first sentence a viewer with no context needs to follow this idea. " +
      "Prefer an opening line that catches attention.\n",
  );
  text = swap(
    text,
    "Stop there: a supporting verse, a reason, or a restatement he adds after the punch line is not the ending. End on the " +
      "strongest line, not on the last related line. ",
    "",
  );
  text = swap(text, "the hook, the explanation or story, and the payoff", "the setup, the explanation or story, and the payoff");
  text = swap(text, "Go past 60 only when the point cannot land sooner, and then by as little as it needs; when the point needs", "When the point needs");
  text = swap(text, " A later start on the hook and an earlier end on the punch line both shorten the clip; prefer them to a longer clip.", "");
  return text;
}
const classicEndLookPrompt: typeof endLookPrompt = (lines, end, last) =>
  swap(
    endLookPrompt(lines, end, last),
    "Never move past a line like that to add a supporting verse, a reason, or a restatement of it: the clip ends on the " +
      "strongest line, not on the last related line. ",
    "",
  );

/** Fix Z's targets: the lines Jake named for the nine clips he failed in the fix W + X + Y round, as search keys. */
const WANTED: { sermon: string; rank: number; start?: string[]; end?: string[] }[] = [
  { sermon: "Lab 1p", rank: 2, start: ["here's my question today"] },
  { sermon: "Lab 1p", rank: 1, start: ["stronger and mightier than the devil"], end: ["power of the lord jesus christ"] },
  { sermon: "Lab 1p", rank: 4, end: ["he loves you"] },
  { sermon: "Lab 1p", rank: 6, start: ["you know what jesus wants to do today"] },
  { sermon: "Lab 2l", rank: 2, start: ["listen to me, church", "never give up on anybody"] },
  { sermon: "Lab 2l", rank: 6, start: ["give you some hope tonight"] },
  { sermon: "Lab 3l", rank: 2, end: ["today's the day of salvation"] },
  { sermon: "Lab 4j", rank: 3, start: ["the gospel never changes"] },
  { sermon: "Lab 5h", rank: 2, start: ["got their doctrine straight"] },
  { sermon: "Lab 5h", rank: 4, start: ["the bible says jesus felt something go out of him"] },
];
const norm = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9', ]/g, " ").replace(/\s+/g, " ").trim();
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

async function main() {
  const args = readArgs(process.argv.slice(2));
  const fixArg = args.get("fix");
  if (typeof fixArg !== "string" || !(FIXES as readonly string[]).includes(fixArg)) {
    console.error(`Usage: npm run lab:replay -- --fix ${FIXES.join("|")} [--only "Lab 1n"] [--concurrency 4] [--out replay.json] [--reask] [--control]`);
    process.exit(2);
  }
  const fix = fixArg as Fix;
  const only = typeof args.get("only") === "string" ? (args.get("only") as string) : null;
  REASK = args.get("reask") === true;
  CONTROL = args.get("control") === true;
  const concurrency = typeof args.get("concurrency") === "string" ? Number(args.get("concurrency")) : 4;
  const out = typeof args.get("out") === "string" ? (args.get("out") as string) : path.join(os.tmpdir(), `lab-replay-${fix}-${Date.now()}.json`);

  assertLabEnvironment({ requireAnthropicKey: fix === "U" || fix === "AB" || fix === "X" || fix === "Y" || fix === "Z" });

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
      const boundary =
        (steps?.metadata as { boundary?: { to?: [number, number] | null; endLook?: { movedMs?: number } }[] } | null)?.boundary ?? [];
      // Fixes V, Y and AC read the recording. A project's own source file, or another lab copy of the same video.
      let source: string | null = null;
      if (fix === "V" || fix === "Y" || fix === "AC") {
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
        const entry = boundary.find((b) => b.to && b.to[0] === clip.startMs && b.to[1] === clip.endMs);
        const lookMoved = entry?.endLook && typeof entry.endLook.movedMs === "number" ? entry.endLook.movedMs : 0;
        marked.push({ sermon, projectId: label.projectId, clipId, ...clip, preLookEndMs: clip.endMs - lookMoved });
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
    if (fix === "U" || fix === "AB") {
      const by = (key: string) => rows.filter((r) => r.detail.outcome === key).length;
      console.log(
        `Story check: ${by("extended")} extended, ${by("restarted")} restarted, ${by("unresolved")} unresolved (story goes on, no landing found), ` +
          `${by("cut")} cut before a story the clip only opens (fix AB).`,
      );
      console.log(`Model calls: ${usage.calls}, ${usage.input} input tokens, ${usage.output} output tokens.`);
    }
    if (fix === "X") {
      const verse = rows.filter((r) => r.detail.verseEnd).length;
      const asked = rows.filter((r) => r.detail.reask).length;
      const lookMoved = rows.filter((r) => typeof r.detail.movedMs === "number").length;
      console.log(`Verse ends refused: ${verse}.` + (REASK ? ` The end look was asked again on ${asked} clips and moved ${lookMoved}.` : ""));
      console.log(`Model calls: ${usage.calls}, ${usage.input} input tokens, ${usage.output} output tokens.`);
    }
    if (fix === "Z") {
      const ok = rows.filter((r) => !r.detail.error && typeof r.detail.seconds === "number");
      const count = (verdict: string, key: "startMoved" | "endMoved") => ok.filter((r) => r.verdict === verdict && r.detail[key] === true).length;
      const okPass = ok.filter((r) => r.verdict === "pass").length;
      const okFail = ok.filter((r) => r.verdict === "fail").length;
      console.log(
        `${CONTROL ? "Control (the prompts before fix Z)" : "Fix Z"}: passed clips: ${count("pass", "startMoved")} of ${okPass} starts move, ` +
          `${count("pass", "endMoved")} of ${okPass} ends move. Failed clips: ${count("fail", "startMoved")} of ${okFail} starts move, ` +
          `${count("fail", "endMoved")} of ${okFail} ends move. No range after three refusals: ${rows.length - ok.length - rows.filter((r) => r.detail.error).length}.`,
      );
      const wantStart = rows.filter((r) => r.detail.wantStart !== undefined);
      const wantEnd = rows.filter((r) => r.detail.wantEnd !== undefined);
      console.log(
        `Jake's wanted lines: start hit on ${wantStart.filter((r) => r.detail.wantStart === true).length} of ${wantStart.length}, ` +
          `end hit on ${wantEnd.filter((r) => r.detail.wantEnd === true).length} of ${wantEnd.length}.`,
      );
      const over = (key: "seconds" | "secondsWas") => ok.filter((r) => Number(r.detail[key]) > 60).length;
      const passRows = ok.filter((r) => r.verdict === "pass");
      console.log(
        `Over 60 seconds: ${over("secondsWas")} of ${ok.length} before, ${over("seconds")} after. Median length: ` +
          `${median(ok.map((r) => Number(r.detail.secondsWas))).toFixed(1)} s before, ${median(ok.map((r) => Number(r.detail.seconds))).toFixed(1)} s after. ` +
          `Passed clips over 60 s: ${passRows.filter((r) => Number(r.detail.secondsWas) > 60).length} before, ${passRows.filter((r) => Number(r.detail.seconds) > 60).length} after.`,
      );
      console.log(`Model calls: ${usage.calls}, ${usage.input} input tokens, ${usage.output} output tokens.`);
    }
    if (fix === "Y") {
      const slides = rows.filter((r) => String(r.detail.outcome ?? "").startsWith("slide")).length;
      const unchecked = rows.filter((r) => String(r.detail.outcome ?? "").startsWith("unchecked")).length;
      const sceneFrames = rows.reduce((n, r) => n + Number(r.detail.sceneFrames ?? 0), 0);
      const frames = rows.reduce((n, r) => n + Number(r.detail.frames ?? 0), 0);
      console.log(`Slides found: ${slides}; unchecked: ${unchecked}. Frames shown: ${frames}, of them ${sceneFrames} at scene changes. Vision calls: ${usage.calls}, ${usage.input} input tokens.`);
    }
    if (fix === "AC") {
      const flagged = rows.filter((r) => r.moved);
      const frames = rows.reduce((n, r) => n + Number(r.detail.framesChecked ?? 0), 0);
      console.log(
        `Empty stretches (no face, nobody seen, half a second or more): ${flagged.length} clips flagged, ` +
          `${flagged.filter((r) => r.verdict === "pass").length} passed and ${flagged.filter((r) => r.verdict === "fail").length} failed. ` +
          `The person detector read ${frames} faceless frames.`,
      );
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
            (r.detail.startMoved ? `\n           start: "${String(r.detail.startWas)}" -> "${String(r.detail.startNow)}"` : "") +
            (r.detail.endMoved ? `\n           end: "${String(r.detail.endWas)}" -> "${String(r.detail.endNow)}"` : "") +
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
  if (fix === "AC") {
    if (!source) return { ...clip, to: null, moved: false, detail: { error: "no source file on disk" } };
    const checked = await checkClipEmptyFrames({
      sourceFilePath: source,
      startMs: range.startMs,
      endMs: range.endMs,
      workDir: path.join(os.tmpdir(), "lab-replay-camera"),
    });
    const detail: Record<string, unknown> = { samples: checked.samples, framesChecked: checked.framesChecked, runs: checked.runs };
    if (checked.result.pass) return { ...clip, to: null, moved: false, detail };
    const at = checked.result.at;
    return {
      ...clip,
      to: null,
      moved: true,
      detail: {
        ...detail,
        outcome: `off-screen ${checked.runs.map((r) => `${(r.start - range.startMs / 1000).toFixed(2)}-${(r.end - range.startMs / 1000).toFixed(2)} s`).join(", ")}`,
        at,
        reason: `nobody in the frame at ${formatClock(Math.round(at * 1000))}, ${(at - range.startMs / 1000).toFixed(1)} s into the clip`,
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
  if (fix === "AA" || fix === "AG") {
    const { units, currentStart, currentEnd } = context;
    const skip = (i: number) => (fix === "AA" ? labelStart(units, i) : backReferenceStart(units[i].text));
    let start = currentStart;
    while (start < currentEnd && skip(start)) start += 1;
    if (start === currentStart) return { ...clip, to: null, moved: false, detail: {} };
    const startMs = units[start].startMs;
    return {
      ...clip,
      to: [startMs, range.endMs],
      moved: true,
      detail: {
        outcome: fix === "AA" ? "label start dropped" : "back-reference start dropped",
        movedMs: startMs - range.startMs,
        dropped: units.slice(currentStart, start).map((u) => u.text).join(" "),
        reason:
          fix === "AA"
            ? `"${units.slice(currentStart, start).map((u) => u.text).join(" ")}" then a pause of ${((startMs - units[start - 1].endMs) / 1000).toFixed(1)} s before "${units[start].text.slice(0, 60)}"`
            : `"${units.slice(currentStart, start).map((u) => u.text).join(" ")}" explains the line before it; the clip opens on "${units[start].text.slice(0, 60)}"`,
      },
    };
  }
  if (fix === "AD") {
    const { units, currentStart, currentEnd } = context;
    const brk = sectionBreakInside(units, currentStart, currentEnd);
    if (brk === null) return { ...clip, to: null, moved: false, detail: {} };
    return {
      ...clip,
      to: null,
      moved: true,
      detail: {
        outcome: `spans a section break at line ${brk - currentStart} of ${currentEnd - currentStart}`,
        reason: units[brk].text.slice(0, 120),
      },
    };
  }
  if (fix === "AE") {
    const { units, currentStart, currentEnd } = context;
    let end = currentEnd;
    if (typeof clip.preLookEndMs === "number" && clip.preLookEndMs < range.endMs) {
      while (end > currentStart && units[end].startMs >= clip.preLookEndMs) end -= 1;
    }
    const before = endBeforeNextPoint(units, currentStart, end);
    if (before === end) return { ...clip, to: null, moved: false, detail: {} };
    const endMs = units[before].endMs;
    return {
      ...clip,
      to: [range.startMs, endMs],
      moved: true,
      detail: {
        outcome: `next-point opener cut${end !== currentEnd ? " (the end before the end look)" : ""}`,
        movedMs: endMs - range.endMs,
        dropped: units.slice(before + 1, end + 1).map((u) => u.text).join(" "),
        reason: `"${units[end].text.slice(0, 100)}" opens the next point; the clip ends on "${units[before].text.slice(0, 80)}"`,
      },
    };
  }
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
    const recap = currentEnd > currentStart ? recapIntoNextPoint(units, currentEnd) : null;
    if (recap && recap.first > currentStart) {
      const endMs = units[recap.first - 1].endMs;
      const lines = currentEnd - recap.first + 1;
      return {
        ...clip,
        to: [range.startMs, endMs],
        moved: true,
        detail: {
          outcome: lines === 1 ? "recap dropped" : `recap of ${lines} lines dropped`,
          movedMs: endMs - range.endMs,
          dropped: units.slice(recap.first, currentEnd + 1).map((u) => u.text).join(" "),
          next: units[currentEnd + 1]?.text,
          reason: `recap "${units.slice(recap.first, currentEnd + 1).map((u) => u.text).join(" ").slice(0, 100)}" before "${(units[currentEnd + 1]?.text ?? "").slice(0, 60)}"`,
        },
      };
    }
    return { ...clip, to: null, moved: false, detail: {} };
  }
  if (fix === "Z") {
    const { units, currentStart, currentEnd } = context;
    const client = new Anthropic();
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
    const askLook = async (prompt: string) => {
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
    };
    const detail: Record<string, unknown> = {
      control: CONTROL,
      startWas: units[currentStart].text.slice(0, 100),
      endWas: units[currentEnd].text.slice(0, 100),
      secondsWas: (range.endMs - range.startMs) / 1000,
    };
    // The control runs without fix Z's hook window as well as with the prompts before it.
    const limits: BoundaryLimits | undefined = CONTROL ? { minMs: BOUNDARY_MIN_MS, maxMs: BOUNDARY_MAX_MS, cutMaxMs: BOUNDARY_CUT_MAX_MS } : undefined;
    const chosen = await chooseBoundary(context, askBoundary, limits, null, CONTROL ? classicBoundaryPrompt : boundaryPrompt);
    detail.attempts = chosen.attempts.map(({ startUnit, endUnit, refused }) => ({ startUnit, endUnit, refused }));
    detail.reason = chosen.attempts.at(-1)?.reason;
    if (!chosen.range) return { ...clip, to: null, moved: false, detail: { ...detail, outcome: "no range: three answers refused" } };
    let final = { startMs: chosen.range.startMs, endMs: chosen.range.endMs };
    const looked = await lookPastTheEnd(units, final, askLook, BOUNDARY_MAX_MS, CONTROL ? classicEndLookPrompt : endLookPrompt);
    final = looked.range;
    detail.look = looked.look;
    const startUnit = units.findIndex((u) => u.endMs > final.startMs);
    let endUnit = units.length - 1;
    while (endUnit > startUnit && units[endUnit].startMs >= final.endMs) endUnit -= 1;
    const startMoved = startUnit !== currentStart;
    const endMoved = endUnit !== currentEnd;
    detail.startMoved = startMoved;
    detail.endMoved = endMoved;
    detail.startNow = units[startUnit].text.slice(0, 100);
    detail.endNow = units[endUnit].text.slice(0, 100);
    detail.seconds = (final.endMs - final.startMs) / 1000;
    const want = WANTED.find((w) => w.sermon === clip.sermon && w.rank === clip.rank);
    if (want?.start) detail.wantStart = want.start.some((key) => norm(units[startUnit].text).includes(key));
    if (want?.end) detail.wantEnd = want.end.some((key) => norm(units[endUnit].text).includes(key));
    const parts: string[] = [];
    if (startMoved) parts.push(`start ${final.startMs > range.startMs ? "+" : ""}${((final.startMs - range.startMs) / 1000).toFixed(1)} s`);
    if (endMoved) parts.push(`end ${final.endMs > range.endMs ? "+" : ""}${((final.endMs - range.endMs) / 1000).toFixed(1)} s`);
    if (want) parts.push(`wanted ${want.start ? `start ${detail.wantStart ? "HIT" : "miss"}` : ""}${want.start && want.end ? ", " : ""}${want.end ? `end ${detail.wantEnd ? "HIT" : "miss"}` : ""}`);
    parts.push(`${detail.secondsWas} -> ${(detail.seconds as number).toFixed(1)} s`);
    detail.outcome = parts.join("; ");
    const moved = startMoved || endMoved;
    return { ...clip, to: moved ? [final.startMs, final.endMs] : null, moved, detail };
  }
  if (fix === "U" || fix === "AB") {
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
