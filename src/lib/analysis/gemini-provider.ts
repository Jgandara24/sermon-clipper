import { z } from "zod";
import { env } from "@/lib/env";
import { AnalysisResponseTruncatedError } from "./claude-provider";
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
import type { AnalysisModelCall } from "./usage";
import {
  AnalysisProviderUnavailableError,
  type AnalysisCandidate,
  type AnalysisContext,
} from "./types";

type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { message?: string };
};

function responseSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export class GeminiStageAdapter implements AnalysisStageAdapter {
  readonly provider = "google" as const;
  lastCall: AnalysisModelCall | null = null;

  constructor(
    readonly model: string,
    private readonly pricing: AnalysisModelPrice | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(env.GEMINI_API_KEY);
  }

  private async generate(
    stage: AnalysisModelCall["stage"],
    prompt: string,
    schema: z.ZodType,
  ): Promise<{ text: string; finishReason: string | undefined; call: AnalysisModelCall }> {
    const key = env.GEMINI_API_KEY;
    if (!key) throw new AnalysisProviderUnavailableError("GEMINI_API_KEY is not configured.");
    this.lastCall = null;
    const startedAt = Date.now();
    const response = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: responseSchema(schema),
            maxOutputTokens: 32000,
          },
        }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as GeminiResponse;
    if (!response.ok) {
      throw new Error(body.error?.message ?? `Gemini request failed with HTTP ${response.status}.`);
    }
    const usage = body.usageMetadata ?? {};
    const cached = usage.cachedContentTokenCount ?? 0;
    const call: AnalysisModelCall = {
      stage,
      provider: "google",
      model: this.model,
      inputTokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
      outputTokens: usage.candidatesTokenCount ?? 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: cached,
      wallTimeMs: Date.now() - startedAt,
      outcome: "failed",
      pricing: this.pricing,
    };
    this.lastCall = call;
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    return { text, finishReason: candidate?.finishReason, call };
  }

  async classifyCandidates(candidates: AnalysisCandidate[]): Promise<ClassificationStageOutput> {
    const generated = await this.generate(
      "analysis_classification",
      stageAPrompt(candidates),
      StageAResultSchema,
    );
    if (generated.finishReason === "MAX_TOKENS") {
      throw new AnalysisResponseTruncatedError("Gemini Stage A output was truncated.");
    }
    try {
      const result = StageAResultSchema.parse(JSON.parse(generated.text));
      generated.call.outcome = "succeeded";
      return {
        kept: thinStageASurvivors(candidates, result.classifications),
        call: generated.call,
      };
    } catch (error) {
      throw new AnalysisResponseTruncatedError(
        "Gemini Stage A output did not match the expected schema.",
        { cause: error },
      );
    }
  }

  async scoreCandidates(
    candidates: AnalysisCandidate[],
    kept: number[],
    context: AnalysisContext,
  ): Promise<ScoringStageOutput> {
    const generated = await this.generate(
      "analysis_scoring",
      stageBPrompt(candidates, kept, context),
      StageBResultSchema,
    );
    if (generated.finishReason === "MAX_TOKENS") {
      throw new AnalysisResponseTruncatedError("Gemini Stage B output was truncated.");
    }
    try {
      const result = StageBResultSchema.parse(JSON.parse(generated.text));
      generated.call.outcome = "succeeded";
      return {
        scored: mapStageBResult(candidates, context, result, this.model),
        call: generated.call,
      };
    } catch (error) {
      throw new AnalysisResponseTruncatedError(
        "Gemini Stage B output did not match the expected schema.",
        { cause: error },
      );
    }
  }
}
