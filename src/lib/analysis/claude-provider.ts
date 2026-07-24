import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "@/lib/env";
import { computePlatformFit, computeSpeakerEnergy } from "./computed-subscores";
import { buildChurchSubscores } from "./church-scoring";
import { detectScriptureReferences } from "./scripture";
import { computeTotal, scoreToLetter, SERMON_WEIGHTS } from "./scoring";
import { buildAnalysisUsage, type AnalysisModelCall, type AnalysisUsage } from "./usage";
import {
  AnalysisProviderUnavailableError,
  type AnalysisCandidate,
  type AnalysisContext,
  type AnalysisProvider,
  type ScoredCandidate,
  type Subscore,
} from "./types";

// claude-haiku-4-5 for the cheap Stage A pass, claude-sonnet-5 for Stage B scoring/rationale —
// per guide §3. Sonnet 5 rejects a non-default temperature, so neither call sets one.
// Env-overridable so a model deprecation is a config change, not a code deploy. New model IDs
// should also be added to the pricing table in usage.ts or spend telemetry undercounts.
const DEFAULT_CLASSIFY_MODEL = "claude-haiku-4-5";
const DEFAULT_SCORING_MODEL = "claude-sonnet-5";

export function classifyModel(): string {
  return env.ANALYSIS_MODEL_CLASSIFY || DEFAULT_CLASSIFY_MODEL;
}

export function scoringModel(): string {
  return env.ANALYSIS_MODEL_SCORING || DEFAULT_SCORING_MODEL;
}

const MAX_STAGE_B_CANDIDATES = 25;

// Output ceilings for the two Claude passes. Both must hold the FULL response — constrained
// JSON (output_config.format) can only fail to parse if the token cap cuts it off mid-string.
// Stage A emits one classification per candidate window, and a full-length sermon produces
// hundreds of windows, so its output scales with the transcript, not a fixed clip count.
// Stage B holds up to MAX_STAGE_B_CANDIDATES fully-scored clips (title/hook/summary/excerpt +
// six subscore notes each) under Sonnet 5's heavier tokenizer. Both exceed ~16k, so both stream.
const STAGE_A_MAX_TOKENS = 32000;
const STAGE_B_MAX_TOKENS = 32000;

/** A stage produced no parseable output — almost always truncated at the token cap. */
export class AnalysisResponseTruncatedError extends Error {}

const MomentTypeSchema = z.enum([
  "hook",
  "complete_thought",
  "story",
  "quotable",
  "emotional_peak",
  "teachable",
  "call_to_action",
  "reject",
]);

const StageAResultSchema = z.object({
  classifications: z.array(
    z.object({
      index: z.number().int(),
      momentType: MomentTypeSchema,
    }),
  ),
});

const LlmSubscoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  note: z.string(),
});

const StageBResultSchema = z.object({
  scoredClips: z.array(
    z.object({
      index: z.number().int(),
      title: z.string(),
      hookText: z.string(),
      summary: z.string(),
      excerpt: z.string(),
      subscores: z.object({
        hookStrength: LlmSubscoreSchema,
        clarity: LlmSubscoreSchema,
        emotionalImpact: LlmSubscoreSchema,
        completeness: LlmSubscoreSchema,
        shareability: LlmSubscoreSchema,
        topicRelevance: LlmSubscoreSchema,
      }),
    }),
  ),
});

function toSubscore(llm: { score: number; note: string }): Subscore {
  return { score: llm.score, letter: scoreToLetter(llm.score), note: llm.note };
}

function toModelCall(model: string, usage: Anthropic.Usage): AnalysisModelCall {
  return {
    model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/** Real Claude API analysis — Stage A (Haiku) classifies/rejects, Stage B (Sonnet) scores. */
export class ClaudeAnalysisProvider implements AnalysisProvider {
  get name(): string {
    return scoringModel();
  }

  /** Token usage for the most recent scoreCandidates call — spend telemetry, see usage.ts. */
  lastUsage: AnalysisUsage | null = null;

  async isAvailable(): Promise<boolean> {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  async scoreCandidates(
    candidates: AnalysisCandidate[],
    context: AnalysisContext,
  ): Promise<ScoredCandidate[]> {
    if (!(await this.isAvailable())) {
      throw new AnalysisProviderUnavailableError("ANTHROPIC_API_KEY is not configured.");
    }

    this.lastUsage = null;
    const stageAModel = classifyModel();
    const stageBModel = scoringModel();
    const modelCalls: AnalysisModelCall[] = [];
    const client = new Anthropic();

    // Stage A classifies every candidate window; a full-length sermon produces hundreds, so the
    // classification array scales with the transcript and easily overruns a small token cap.
    // Same reasoning as Stage B below: stream with generous headroom, and treat a truncated or
    // unparseable result as an explicit retryable failure instead of a silent empty classification.
    const stageAStream = client.messages.stream({
      model: stageAModel,
      max_tokens: STAGE_A_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content:
            `Classify each numbered transcript excerpt below by moment type. Use "reject" for ` +
            `anything that starts mid-thought, ends mid-sentence, or is otherwise not a usable ` +
            `standalone clip.\n\n${candidates.map((c, i) => `[${i}] ${c.text}`).join("\n\n")}`,
        },
      ],
      output_config: { format: zodOutputFormat(StageAResultSchema) },
    });
    const stageA = await stageAStream.finalMessage();
    modelCalls.push(toModelCall(stageAModel, stageA.usage));

    if (stageA.stop_reason === "max_tokens") {
      throw new AnalysisResponseTruncatedError(
        `Stage A classification output was truncated at the ${STAGE_A_MAX_TOKENS.toLocaleString()}-token ` +
          `cap while classifying ${candidates.length} candidates.`,
      );
    }

    let stageAText = "";
    for (const block of stageA.content) {
      if (block.type === "text") stageAText += block.text;
    }
    let classifications: z.infer<typeof StageAResultSchema>["classifications"];
    try {
      classifications = StageAResultSchema.parse(JSON.parse(stageAText)).classifications;
    } catch (error) {
      throw new AnalysisResponseTruncatedError(
        "Stage A classification returned output that did not match the expected schema.",
        { cause: error },
      );
    }

    const kept = classifications
      .filter((c) => c.momentType !== "reject")
      .map((c) => c.index)
      .filter((i) => i >= 0 && i < candidates.length)
      .slice(0, MAX_STAGE_B_CANDIDATES);

    if (kept.length === 0) {
      this.lastUsage = buildAnalysisUsage(modelCalls);
      return [];
    }

    // Scoring up to MAX_STAGE_B_CANDIDATES clips — each with six subscore notes plus a
    // title/hook/summary/excerpt — is a large structured payload, and Sonnet 5's tokenizer
    // runs ~30% heavier than older models. With `output_config.format`, generation is
    // constrained to schema-valid JSON, so the only way the result can fail to parse is
    // truncation at the token cap. We stream (the SDK's guidance once max_tokens exceeds
    // ~16k) with generous headroom, and treat a `max_tokens` stop as an explicit retryable
    // failure rather than letting it surface as an "unterminated JSON" parse crash.
    const stageBStream = client.messages.stream({
      model: stageBModel,
      max_tokens: STAGE_B_MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: {
        effort: "medium",
        format: zodOutputFormat(StageBResultSchema),
      },
      messages: [
        {
          role: "user",
          content:
            `You are scoring short-form video clip candidates cut from a longer ${context.genre} ` +
            "recording. For each numbered excerpt, score these categories 0-100: hook strength " +
            "(does the opening grab attention), clarity (understandable without earlier context), " +
            "emotional impact, completeness (the thought resolves), shareability (would someone " +
            "send this to a friend), and topic relevance (connects to the recording's main ideas). " +
            "Write a short title (max 60 characters, no clickbait), a hook line (max 8 words), a " +
            "one-sentence rationale, and an excerpt quote supporting your scoring.\n\n" +
            kept.map((i) => `[${i}] ${candidates[i].text}`).join("\n\n"),
        },
      ],
    });
    const stageB = await stageBStream.finalMessage();

    modelCalls.push(toModelCall(stageBModel, stageB.usage));
    this.lastUsage = buildAnalysisUsage(modelCalls);

    if (stageB.stop_reason === "max_tokens") {
      throw new AnalysisResponseTruncatedError(
        `Stage B scoring output was truncated at the ${STAGE_B_MAX_TOKENS.toLocaleString()}-token ` +
          `cap while scoring ${kept.length} candidates.`,
      );
    }

    let stageBText = "";
    for (const block of stageB.content) {
      if (block.type === "text") stageBText += block.text;
    }

    let scoredClips: z.infer<typeof StageBResultSchema>["scoredClips"];
    try {
      scoredClips = StageBResultSchema.parse(JSON.parse(stageBText)).scoredClips;
    } catch (error) {
      throw new AnalysisResponseTruncatedError(
        "Stage B scoring returned output that did not match the expected schema.",
        { cause: error },
      );
    }

    return scoredClips
      .filter((clip) => clip.index >= 0 && clip.index < candidates.length)
      .map((clip) => {
        const candidate = candidates[clip.index];
        const durationS = (candidate.endMs - candidate.startMs) / 1000;
        const wordCount = candidate.text.split(/\s+/).filter(Boolean).length;

        const baseSubscores = {
          hook_strength: toSubscore(clip.subscores.hookStrength),
          clarity: toSubscore(clip.subscores.clarity),
          emotional_impact: toSubscore(clip.subscores.emotionalImpact),
          completeness: toSubscore(clip.subscores.completeness),
          shareability: toSubscore(clip.subscores.shareability),
          topic_relevance: toSubscore(clip.subscores.topicRelevance),
          speaker_energy: computeSpeakerEnergy(wordCount, durationS),
          platform_fit: computePlatformFit(durationS),
        };
        const isSermon = context.genre.toLowerCase() === "sermon";
        const scriptureReferences = isSermon ? detectScriptureReferences(candidate.text) : [];
        const subscores = isSermon
          ? {
              clarity: baseSubscores.clarity,
              emotional_impact: baseSubscores.emotional_impact,
              completeness: baseSubscores.completeness,
              shareability: baseSubscores.shareability,
              speaker_energy: baseSubscores.speaker_energy,
              platform_fit: baseSubscores.platform_fit,
              ...buildChurchSubscores(candidate.text),
            }
          : baseSubscores;

        return {
          startMs: candidate.startMs,
          endMs: candidate.endMs,
          text: candidate.text,
          title: clip.title,
          hookText: clip.hookText,
          summary: clip.summary,
          excerpt: clip.excerpt,
          total: computeTotal(subscores, isSermon ? SERMON_WEIGHTS : undefined),
          subscores,
          modelVersion: stageBModel,
          scriptureReferences,
        };
      });
  }
}
