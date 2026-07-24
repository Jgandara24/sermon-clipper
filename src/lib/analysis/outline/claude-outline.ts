import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "@/lib/env";
import type { TranscriptSegmentInput } from "../chunking";
import {
  AnalysisResponseTruncatedError,
  classifyModel,
  scoringModel,
} from "../claude-provider";
import type { AnalysisModelCall } from "../usage";
import { buildAnalysisBlocks } from "./blocks";
import { buildHeuristicOutline, buildSingleSectionOutline, detectHeuristicExclusions } from "./heuristic";
import {
  OutlineGenerationError,
  type AnalysisBlock,
  type ExclusionRange,
  type ExclusionReason,
  type SermonOutlineDraft,
} from "./types";
import { resolveSectionAnchors, type RawSectionAnchor } from "./validate";

export function outlineModel(): string {
  return env.ANALYSIS_MODEL_OUTLINE || scoringModel();
}

// Outline outputs are compact (block labels, a handful of sections), nothing like the
// per-candidate payloads of the scoring stages — but stream with headroom anyway, matching the
// house pattern of treating a max_tokens stop as an explicit retryable truncation.
const OUTLINE_STAGE_MAX_TOKENS = 16000;

// Anchor markers are injected into the compose prompt roughly this often. Outline boundaries
// only need ~20s precision (clip discovery re-anchors per segment later), and sparser markers
// keep the prompt smaller than marking every ~2s whisper segment.
const MARKER_INTERVAL_MS = 20_000;

const BlockContentSchema = z.object({
  blocks: z.array(
    z.object({
      blockIdx: z.number().int(),
      contentType: z.enum([
        "preaching",
        "worship",
        "announcement",
        "baptism",
        "invitation",
        "altar_call",
        "prayer",
        "other_speaker",
        "other",
      ]),
      summary: z.string(),
    }),
  ),
});

const SectionAnchorSchema = z.object({
  type: z.enum(["introduction", "point", "conclusion"]),
  heading: z.string(),
  summary: z.string(),
  startSegment: z.number().int(),
  endSegment: z.number().int(),
  confidence: z.number().min(0).max(1),
});

const OutlineComposeSchema = z.object({
  mainIdea: z.string(),
  title: z.string(),
  confidence: z.number().min(0).max(1),
  sections: z.array(SectionAnchorSchema),
  // Spans inside otherwise-preaching content that are not the pastor actively preaching (e.g.
  // the conclusion drifting into an invitation) — finer-grained than the block triage.
  refinedExclusions: z.array(
    z.object({
      startSegment: z.number().int(),
      endSegment: z.number().int(),
      reason: z.enum(["worship", "announcement", "baptism", "invitation", "altar_call", "prayer", "not_preaching"]),
    }),
  ),
});

const EXCLUDED_CONTENT_REASON: Record<string, ExclusionReason> = {
  worship: "worship",
  announcement: "announcement",
  baptism: "baptism",
  invitation: "invitation",
  altar_call: "altar_call",
  prayer: "prayer",
  other_speaker: "not_preaching",
  other: "not_preaching",
};

function formatClock(ms: number): string {
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Renders segments as prose with `[S<idx>]` anchor markers roughly every MARKER_INTERVAL_MS.
 * The model must express section boundaries as these marker numbers — never invented
 * timestamps — so anchors always resolve deterministically back to real segments.
 */
export function renderMarkedText(segments: TranscriptSegmentInput[]): string {
  const parts: string[] = [];
  let lastMarkerMs = -Infinity;
  for (const segment of segments) {
    if (segment.startMs - lastMarkerMs >= MARKER_INTERVAL_MS) {
      parts.push(`[S${segment.idx}]`);
      lastMarkerMs = segment.startMs;
    }
    parts.push(segment.text);
  }
  return parts.join(" ");
}

async function runOutlineStage<T extends z.ZodTypeAny>(
  client: Anthropic,
  model: string,
  prompt: string,
  schema: T,
  calls: AnalysisModelCall[],
): Promise<z.infer<T>> {
  const stream = client.messages.stream({
    model,
    max_tokens: OUTLINE_STAGE_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: zodOutputFormat(schema) },
  });
  const message = await stream.finalMessage();
  calls.push({
    model,
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
  });
  if (message.stop_reason === "max_tokens") {
    throw new AnalysisResponseTruncatedError("Outline stage output was truncated at the token cap.");
  }
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    throw new AnalysisResponseTruncatedError(
      "Outline stage returned output that did not match the expected schema.",
      { cause: error },
    );
  }
}

/** Block triage (call 1): dominant content type + one-sentence summary per 3–5 minute block. */
async function classifyBlocks(
  client: Anthropic,
  blocks: AnalysisBlock[],
  calls: AnalysisModelCall[],
): Promise<z.infer<typeof BlockContentSchema>["blocks"]> {
  const prompt =
    `Below is a church service recording's transcript divided into numbered blocks. For each ` +
    `block, identify its DOMINANT content type and write a one-sentence summary of what happens ` +
    `in it.\n\nContent types:\n` +
    `- "preaching": the primary pastor actively teaching/preaching the sermon\n` +
    `- "worship": music, singing, worship team\n` +
    `- "announcement": church announcements, welcomes, offering instructions, housekeeping\n` +
    `- "baptism": baptism activity\n` +
    `- "invitation": salvation invitation / response moment\n` +
    `- "altar_call": calling people forward to the altar\n` +
    `- "prayer": extended prayer that is not part of the teaching\n` +
    `- "other_speaker": someone other than the primary preacher speaking (testimony, guest, emcee)\n` +
    `- "other": anything else that is not the pastor preaching\n\n` +
    blocks
      .map(
        (b) =>
          `[B${b.blockIdx}] (${formatClock(b.startMs)}–${formatClock(b.endMs)}) ` +
          b.segments.map((s) => s.text).join(" "),
      )
      .join("\n\n");
  const result = await runOutlineStage(client, classifyModel(), prompt, BlockContentSchema, calls);
  return result.blocks;
}

function blockExclusions(
  blocks: AnalysisBlock[],
  classified: z.infer<typeof BlockContentSchema>["blocks"],
): ExclusionRange[] {
  const byIdx = new Map(classified.map((c) => [c.blockIdx, c]));
  const ranges: ExclusionRange[] = [];
  for (const block of blocks) {
    const contentType = byIdx.get(block.blockIdx)?.contentType ?? "preaching";
    if (contentType === "preaching") continue;
    const reason = EXCLUDED_CONTENT_REASON[contentType] ?? "not_preaching";
    const last = ranges[ranges.length - 1];
    if (last && last.reason === reason && block.startMs - last.endMs <= 1) {
      last.endMs = block.endMs;
    } else {
      ranges.push({ startMs: block.startMs, endMs: block.endMs, reason });
    }
  }
  return ranges;
}

function composePrompt(
  markedText: string,
  blockSummaries: string,
  simple: boolean,
): string {
  const structureAsk = simple
    ? `Divide the PREACHING content into exactly three sections: one "introduction", one "point" ` +
      `(the main body of the message), and one "conclusion".`
    : `Reconstruct the sermon's outline from the PREACHING content: an introduction, each main ` +
      `point the pastor develops (listen for numbering like "the first thing…", "my second ` +
      `point…", scripture changes like "turn with me to…", and semantic topic shifts when points ` +
      `aren't numbered explicitly), and a conclusion. Use type "point" for every main point.`;
  return (
    `You are reconstructing the structure of a sermon from its transcript.\n\n` +
    `Block-by-block triage of the full service:\n${blockSummaries}\n\n` +
    `${structureAsk}\n\n` +
    `Rules:\n` +
    `- Anchor every section to the [S<number>] markers embedded in the transcript below: ` +
    `startSegment/endSegment MUST be numbers that appear as markers. Never invent timestamps.\n` +
    `- Sections must be in order and must not overlap.\n` +
    `- Sections together should cover all of the preaching content.\n` +
    `- Worship, announcements, baptisms, invitations, altar calls, and prayer-only moments are ` +
    `NOT sections. If preaching drifts into one of these (e.g. the conclusion becomes an ` +
    `invitation), end the section before the drift and report the span in refinedExclusions.\n` +
    `- Give each section a short heading in the pastor's own framing, a one-sentence summary, ` +
    `and a 0-1 confidence that its boundaries are right.\n` +
    `- Also produce the sermon's main idea (one sentence) and a short generated title, plus a ` +
    `0-1 overall confidence.\n\n` +
    `Transcript of the preaching blocks with anchor markers:\n${markedText}`
  );
}

export type OutlineGenerationOutput = {
  draft: SermonOutlineDraft;
  calls: AnalysisModelCall[];
};

/**
 * Full AI outline generation: block triage (cheap model) → outline composition over
 * marker-anchored preaching text (scoring-tier model) → deterministic anchor resolution and
 * validation. Throws OutlineGenerationError / AnalysisResponseTruncatedError upward; the
 * reliability tiers in generateSermonOutline decide what happens next.
 */
async function generateOutlineOnce(
  client: Anthropic,
  segments: TranscriptSegmentInput[],
  calls: AnalysisModelCall[],
  options: { simple: boolean },
): Promise<SermonOutlineDraft> {
  const blocks = buildAnalysisBlocks(segments);
  if (blocks.length === 0) throw new OutlineGenerationError("No analysis blocks.");

  const classified = await classifyBlocks(client, blocks, calls);
  const exclusions = blockExclusions(blocks, classified);

  const classifiedByIdx = new Map(classified.map((c) => [c.blockIdx, c]));
  const preachingBlocks = blocks.filter(
    (b) => (classifiedByIdx.get(b.blockIdx)?.contentType ?? "preaching") === "preaching",
  );
  if (preachingBlocks.length === 0) {
    throw new OutlineGenerationError("Block triage found no preaching content.");
  }

  const blockSummaries = blocks
    .map((b) => {
      const c = classifiedByIdx.get(b.blockIdx);
      return `[B${b.blockIdx}] (${formatClock(b.startMs)}–${formatClock(b.endMs)}) ${c?.contentType ?? "preaching"}: ${c?.summary ?? ""}`;
    })
    .join("\n");
  const markedText = renderMarkedText(preachingBlocks.flatMap((b) => b.segments));

  const composed = await runOutlineStage(
    client,
    outlineModel(),
    composePrompt(markedText, blockSummaries, options.simple),
    OutlineComposeSchema,
    calls,
  );

  const segmentByIdx = new Map(segments.map((s) => [s.idx, s]));
  const refined: ExclusionRange[] = composed.refinedExclusions
    .map((e): ExclusionRange | null => {
      const start = segmentByIdx.get(e.startSegment);
      const end = segmentByIdx.get(e.endSegment);
      if (!start || !end || start.startMs >= end.endMs) return null;
      return { startMs: start.startMs, endMs: end.endMs, reason: e.reason };
    })
    .filter((e): e is ExclusionRange => e !== null);
  const allExclusions = [...exclusions, ...refined].sort((a, b) => a.startMs - b.startMs);

  const rawAnchors: RawSectionAnchor[] = composed.sections.map((s) => ({
    type: s.type,
    heading: s.heading,
    summary: s.summary,
    startSegmentIdx: s.startSegment,
    endSegmentIdx: s.endSegment,
    confidence: s.confidence,
  }));
  const sections = resolveSectionAnchors(
    rawAnchors,
    preachingBlocks.flatMap((b) => b.segments),
    allExclusions,
  );

  return {
    mainIdea: composed.mainIdea.trim(),
    generatedTitle: composed.title.trim() || null,
    modelVersion: outlineModel(),
    confidence: composed.confidence,
    status: "generated",
    sections,
    exclusions: allExclusions,
  };
}

/**
 * Sermon outlining with the reliability ladder from the guide: full AI outline → retry with a
 * simpler three-section request → transition/pause heuristics → a single "Main Message"
 * section. Never throws and never returns null — clip generation must not gain a new single
 * point of failure. When `client` is null (no API key), only the two deterministic tiers run.
 */
export async function generateSermonOutline(
  segments: TranscriptSegmentInput[],
  client: Anthropic | null,
): Promise<OutlineGenerationOutput> {
  const calls: AnalysisModelCall[] = [];

  if (client) {
    for (const simple of [false, true]) {
      try {
        return { draft: await generateOutlineOnce(client, segments, calls, { simple }), calls };
      } catch {
        // Fall through to the next tier; the ladder exists precisely to absorb these.
      }
    }
  }

  const heuristic = buildHeuristicOutline(segments);
  if (heuristic) return { draft: heuristic, calls };
  const single = buildSingleSectionOutline(segments);
  // Even the last tier reports lexical exclusions so no tier ships worship/announcement spans.
  single.exclusions = detectHeuristicExclusions(segments);
  return { draft: single, calls };
}
