import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { env } from "@/lib/env";
import {
  mapStageBResult,
  stageAPrompt,
  stageBPrompt,
  StageAResultSchema,
  StageBResultSchema,
  thinStageASurvivors,
} from "./pipeline";
import type { AnalysisModelPrice } from "./routing";
import type {
  AnalysisStageAdapter,
  ClassificationStageOutput,
  ScoringStageOutput,
} from "./stage-adapter";
import { buildAnalysisUsage, type AnalysisModelCall, type AnalysisUsage } from "./usage";
import {
  AnalysisProviderUnavailableError,
  type AnalysisCandidate,
  type AnalysisContext,
  type AnalysisProvider,
  type ScoredCandidate,
} from "./types";

const DEFAULT_CLASSIFY_MODEL = "claude-haiku-4-5";
const DEFAULT_SCORING_MODEL = "claude-sonnet-5";
const STAGE_A_MAX_TOKENS = 32000;
const STAGE_B_MAX_TOKENS = 32000;

export function classifyModel(): string {
  return env.ANALYSIS_MODEL_CLASSIFY || DEFAULT_CLASSIFY_MODEL;
}

export function scoringModel(): string {
  return env.ANALYSIS_MODEL_SCORING || DEFAULT_SCORING_MODEL;
}

/** A stage produced no parseable output. */
export class AnalysisResponseTruncatedError extends Error {}

function callFromUsage(
  stage: AnalysisModelCall["stage"],
  model: string,
  usage: Anthropic.Usage,
  wallTimeMs: number,
  pricing: AnalysisModelPrice | null,
): AnalysisModelCall {
  return {
    stage,
    provider: "anthropic",
    model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    wallTimeMs,
    outcome: "failed",
    pricing,
  };
}

function textContent(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export class ClaudeStageAdapter implements AnalysisStageAdapter {
  readonly provider = "anthropic" as const;
  lastCall: AnalysisModelCall | null = null;

  constructor(
    readonly model: string,
    private readonly pricing: AnalysisModelPrice | null,
  ) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  async classifyCandidates(candidates: AnalysisCandidate[]): Promise<ClassificationStageOutput> {
    if (!(await this.isAvailable())) {
      throw new AnalysisProviderUnavailableError("ANTHROPIC_API_KEY is not configured.");
    }
    this.lastCall = null;
    const startedAt = Date.now();
    const stream = new Anthropic().messages.stream({
      model: this.model,
      max_tokens: STAGE_A_MAX_TOKENS,
      messages: [{ role: "user", content: stageAPrompt(candidates) }],
      output_config: { format: zodOutputFormat(StageAResultSchema) },
    });
    const message = await stream.finalMessage();
    const call = callFromUsage(
      "analysis_classification",
      this.model,
      message.usage,
      Date.now() - startedAt,
      this.pricing,
    );
    this.lastCall = call;
    if (message.stop_reason === "max_tokens") {
      throw new AnalysisResponseTruncatedError(
        `Stage A classification output was truncated at the ${STAGE_A_MAX_TOKENS.toLocaleString()}-token cap while classifying ${candidates.length} candidates.`,
      );
    }
    try {
      const result = StageAResultSchema.parse(JSON.parse(textContent(message)));
      call.outcome = "succeeded";
      return { kept: thinStageASurvivors(candidates, result.classifications), call };
    } catch (error) {
      throw new AnalysisResponseTruncatedError(
        "Stage A classification returned output that did not match the expected schema.",
        { cause: error },
      );
    }
  }

  async scoreCandidates(
    candidates: AnalysisCandidate[],
    kept: number[],
    context: AnalysisContext,
  ): Promise<ScoringStageOutput> {
    if (!(await this.isAvailable())) {
      throw new AnalysisProviderUnavailableError("ANTHROPIC_API_KEY is not configured.");
    }
    this.lastCall = null;
    const startedAt = Date.now();
    const stream = new Anthropic().messages.stream({
      model: this.model,
      max_tokens: STAGE_B_MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: { effort: "medium", format: zodOutputFormat(StageBResultSchema) },
      messages: [{ role: "user", content: stageBPrompt(candidates, kept, context) }],
    });
    const message = await stream.finalMessage();
    const call = callFromUsage(
      "analysis_scoring",
      this.model,
      message.usage,
      Date.now() - startedAt,
      this.pricing,
    );
    this.lastCall = call;
    if (message.stop_reason === "max_tokens") {
      throw new AnalysisResponseTruncatedError(
        `Stage B scoring output was truncated at the ${STAGE_B_MAX_TOKENS.toLocaleString()}-token cap while scoring ${kept.length} candidates.`,
      );
    }
    try {
      const result = StageBResultSchema.parse(JSON.parse(textContent(message)));
      call.outcome = "succeeded";
      return { scored: mapStageBResult(candidates, context, result, this.model), call };
    } catch (error) {
      throw new AnalysisResponseTruncatedError(
        "Stage B scoring returned output that did not match the expected schema.",
        { cause: error },
      );
    }
  }
}

export type ClaudeAnalysisProviderOptions = {
  classificationModel?: string;
  scoringModel?: string;
  classificationPrice?: AnalysisModelPrice | null;
  scoringPrice?: AnalysisModelPrice | null;
};

/** Compatibility wrapper for the default all-Claude route. */
export class ClaudeAnalysisProvider implements AnalysisProvider {
  readonly classification: ClaudeStageAdapter;
  readonly scoring: ClaudeStageAdapter;
  lastUsage: AnalysisUsage | null = null;

  constructor(private readonly options: ClaudeAnalysisProviderOptions = {}) {
    this.classification = new ClaudeStageAdapter(
      options.classificationModel ?? classifyModel(),
      options.classificationPrice ?? null,
    );
    this.scoring = new ClaudeStageAdapter(
      options.scoringModel ?? scoringModel(),
      options.scoringPrice ?? null,
    );
  }

  get name(): string {
    return this.scoring.model;
  }

  async isAvailable(): Promise<boolean> {
    return this.classification.isAvailable();
  }

  async scoreCandidates(
    candidates: AnalysisCandidate[],
    context: AnalysisContext,
  ): Promise<ScoredCandidate[]> {
    this.lastUsage = null;
    const calls: AnalysisModelCall[] = [];
    try {
      const classification = await this.classification.classifyCandidates(candidates);
      calls.push(classification.call);
      this.lastUsage = buildAnalysisUsage(calls);
      if (classification.kept.length === 0) return [];
      const scoring = await this.scoring.scoreCandidates(candidates, classification.kept, context);
      calls.push(scoring.call);
      this.lastUsage = buildAnalysisUsage(calls);
      return scoring.scored;
    } catch (error) {
      for (const adapter of [this.classification, this.scoring]) {
        if (adapter.lastCall && !calls.includes(adapter.lastCall)) calls.push(adapter.lastCall);
      }
      this.lastUsage = buildAnalysisUsage(calls);
      throw error;
    }
  }
}
