import { z } from "zod";
import { computeIoU } from "./chunking";
import { computePlatformFit, computeSpeakerEnergy } from "./computed-subscores";
import { buildChurchSubscores } from "./church-scoring";
import { detectScriptureReferences } from "./scripture";
import { computeTotal, scoreToLetter, SERMON_WEIGHTS } from "./scoring";
import type { AnalysisCandidate, AnalysisContext, ScoredCandidate, Subscore } from "./types";

export const MAX_STAGE_B_CANDIDATES = 25;

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

export const StageAResultSchema = z.object({
  classifications: z.array(
    z.object({ index: z.number().int(), momentType: MomentTypeSchema }),
  ),
});

const LlmSubscoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  note: z.string(),
});

export const StageBResultSchema = z.object({
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

export type StageAResult = z.infer<typeof StageAResultSchema>;
export type StageBResult = z.infer<typeof StageBResultSchema>;

export function stageAPrompt(candidates: AnalysisCandidate[]): string {
  return (
    `Classify each numbered transcript excerpt below by its strongest moment type. ` +
    `Reserve "reject" for excerpts that are genuinely unusable as a standalone clip: no ` +
    `discernible point, cut off so badly the idea can't be followed, or pure housekeeping ` +
    `(announcements, greetings, mic checks). An excerpt with slightly rough edges that ` +
    `still carries a complete, compelling idea should be classified by that idea, not ` +
    `rejected — a later pass scores and trims the survivors.\n\n` +
    candidates.map((candidate, index) => `[${index}] ${candidate.text}`).join("\n\n")
  );
}

export function stageBPrompt(
  candidates: AnalysisCandidate[],
  kept: number[],
  context: AnalysisContext,
): string {
  return (
    `You are scoring short-form video clip candidates cut from a longer ${context.genre} ` +
    "recording. For each numbered excerpt, score these categories 0-100: hook strength " +
    "(does the opening grab attention), clarity (understandable without earlier context), " +
    "emotional impact, completeness (the thought resolves), shareability (would someone " +
    "send this to a friend), and topic relevance (connects to the recording's main ideas). " +
    "Write a short title (max 60 characters, no clickbait), a hook line (max 8 words), a " +
    "one-sentence rationale, and an excerpt quote supporting your scoring.\n\n" +
    kept.map((index) => `[${index}] ${candidates[index].text}`).join("\n\n")
  );
}

export function thinStageASurvivors(
  candidates: AnalysisCandidate[],
  classifications: StageAResult["classifications"],
): number[] {
  const survivors = classifications
    .filter((classification) => classification.momentType !== "reject")
    .map((classification) => classification.index)
    .filter((index) => index >= 0 && index < candidates.length);
  const kept: number[] = [];
  for (const index of survivors) {
    if (kept.length >= MAX_STAGE_B_CANDIDATES) break;
    if (!kept.some((other) => computeIoU(candidates[other], candidates[index]) > 0.5)) {
      kept.push(index);
    }
  }
  return kept;
}

function toSubscore(llm: { score: number; note: string }): Subscore {
  return { score: llm.score, letter: scoreToLetter(llm.score), note: llm.note };
}

export function mapStageBResult(
  candidates: AnalysisCandidate[],
  context: AnalysisContext,
  result: StageBResult,
  model: string,
): ScoredCandidate[] {
  return result.scoredClips
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
        modelVersion: model,
        scriptureReferences,
      };
    });
}
