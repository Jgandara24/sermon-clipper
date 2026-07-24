import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { TranscriptSegmentInput } from "../chunking";
import { AnalysisResponseTruncatedError, scoringModel } from "../claude-provider";
import type { OutlineSectionDraft } from "../outline/types";
import type { AnalysisModelCall } from "../usage";

// A section rarely holds more than a few genuinely distinct strong moments; more than this and
// the model starts nominating variations of the same beat.
const MAX_MOMENTS_PER_SECTION = 4;
const DISCOVERY_MAX_TOKENS = 8000;

export const MOMENT_TYPES = [
  "hook",
  "teaching",
  "quotable",
  "story",
  "emotional",
  "scripture_explanation",
  "application",
  "call_to_action",
] as const;

const DiscoverySchema = z.object({
  moments: z.array(
    z.object({
      momentType: z.enum(MOMENT_TYPES),
      startSegment: z.number().int(),
      endSegment: z.number().int(),
      note: z.string(),
    }),
  ),
});

export type DiscoveredMoment = {
  sectionPosition: number;
  momentType: (typeof MOMENT_TYPES)[number];
  startSegmentIdx: number;
  endSegmentIdx: number;
  note: string;
};

/** Renders a section's segments with a `[S<idx>]` marker on every segment for exact anchoring. */
function renderSectionText(segments: TranscriptSegmentInput[]): string {
  return segments.map((s) => `[S${s.idx}] ${s.text}`).join(" ");
}

/**
 * Section-level clip discovery: asks the model for the strongest self-contained moments inside
 * ONE outline section, expressed strictly as transcript segment anchors — never invented
 * timestamps. Deterministic code (resolve.ts) turns anchors into snapped, duration-clamped
 * windows afterwards. Replaces the "generate hundreds of windows and hope" Stage A for the
 * outline-first path.
 */
export async function discoverSectionMoments(
  client: Anthropic,
  section: OutlineSectionDraft,
  sectionSegments: TranscriptSegmentInput[],
  context: { mainIdea: string; minMs: number; maxMs: number },
  calls: AnalysisModelCall[],
): Promise<DiscoveredMoment[]> {
  if (sectionSegments.length === 0) return [];
  const model = scoringModel();

  const stream = client.messages.stream({
    model,
    max_tokens: DISCOVERY_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content:
          `You are finding the strongest short-form clip moments inside one section of a sermon.\n` +
          `Sermon main idea: ${context.mainIdea}\n` +
          `Section: ${section.heading} (${section.type}) — ${section.summary}\n\n` +
          `Find up to ${MAX_MOMENTS_PER_SECTION} of this section's strongest moments: hooks, ` +
          `complete teachings, quotable statements, stories or illustrations, emotional moments, ` +
          `scripture explanations, applications, or calls to action.\n\n` +
          `Rules:\n` +
          `- Each moment must be the primary pastor actively preaching. Skip worship, ` +
          `announcements, prayers, invitations, altar calls, and anything spoken by someone else.\n` +
          `- Each moment must work as a standalone clip: a complete thought a viewer can follow ` +
          `with zero context, roughly ${Math.round(context.minMs / 1000)}–` +
          `${Math.round(context.maxMs / 1000)} seconds of speech.\n` +
          `- Anchor each moment with startSegment/endSegment using the [S<number>] markers in ` +
          `the transcript below. Only numbers that appear as markers are valid. Never invent ` +
          `timestamps.\n` +
          `- Start at the sentence that opens the thought and end where the thought resolves.\n` +
          `- Nominate distinct moments — no overlapping or near-duplicate spans.\n` +
          `- If this section has no strong standalone moment, return an empty list rather than ` +
          `forcing a weak one.\n\n` +
          `Section transcript with segment markers:\n${renderSectionText(sectionSegments)}`,
      },
    ],
    output_config: { format: zodOutputFormat(DiscoverySchema) },
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
    throw new AnalysisResponseTruncatedError(
      "Moment discovery output was truncated at the token cap.",
    );
  }

  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  let parsed: z.infer<typeof DiscoverySchema>;
  try {
    parsed = DiscoverySchema.parse(JSON.parse(text));
  } catch (error) {
    throw new AnalysisResponseTruncatedError(
      "Moment discovery returned output that did not match the expected schema.",
      { cause: error },
    );
  }

  return parsed.moments.slice(0, MAX_MOMENTS_PER_SECTION).map((moment) => ({
    sectionPosition: section.position,
    momentType: moment.momentType,
    startSegmentIdx: moment.startSegment,
    endSegmentIdx: moment.endSegment,
    note: moment.note,
  }));
}
