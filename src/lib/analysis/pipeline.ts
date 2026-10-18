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
    // Lab sermon 1 (2026-10-17): with only "housekeeping" named, Stage A kept song lyrics,
    // baptisms and announcements, and all six clips came from them. The product only posts the
    // preacher preaching (docs/FOUNDER_BRIEF.md, quality test 2).
    `These excerpts may come from a full church service. Also "reject" every part of the ` +
    `service where the preacher is not preaching: worship and song lyrics being sung, ` +
    `baptisms, announcements, the offering, welcomes, prayer led as part of the service ` +
    `(praying aloud to God rather than teaching), and the altar call or invitation at the ` +
    `close. A preacher who quotes a song line, reads Scripture aloud, or tells a story about ` +
    `a baptism inside the message is still preaching — classify that by its idea.\n\n` +
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

/**
 * Chooses which Stage A survivors Stage B scores: at most MAX_STAGE_B_CANDIDATES windows that do
 * not overlap heavily, spread across the whole recording, returned in time order.
 *
 * It used to keep the first 25 survivors in time order. On an 85-minute service that meant the
 * opening 12 minutes and never the sermon (lab sermon 1, 2026-10-17). Now the recording's span
 * is cut into one equal slot per pick, and each slot takes the unused survivor nearest its
 * centre. Spreading by time, not by count, matters because sung lyrics make short transcript
 * segments and so more windows per minute than preaching does.
 */
export function thinStageASurvivors(
  candidates: AnalysisCandidate[],
  classifications: StageAResult["classifications"],
): number[] {
  const survivors = [
    ...new Set(
      classifications
        .filter((classification) => classification.momentType !== "reject")
        .map((classification) => classification.index)
        .filter((index) => index >= 0 && index < candidates.length),
    ),
  ].sort((a, b) => candidates[a].startMs - candidates[b].startMs || a - b);

  const pool: number[] = [];
  for (const index of survivors) {
    if (!pool.some((other) => computeIoU(candidates[other], candidates[index]) > 0.5)) {
      pool.push(index);
    }
  }
  if (pool.length <= MAX_STAGE_B_CANDIDATES) return pool;

  const midpoint = (index: number) => (candidates[index].startMs + candidates[index].endMs) / 2;
  const spanStart = candidates[pool[0]].startMs;
  const spanEnd = Math.max(...pool.map((index) => candidates[index].endMs));
  const slotMs = (spanEnd - spanStart) / MAX_STAGE_B_CANDIDATES;
  const chosen = new Set<number>();
  for (let slot = 0; slot < MAX_STAGE_B_CANDIDATES; slot += 1) {
    const target = spanStart + (slot + 0.5) * slotMs;
    let best = -1;
    for (const index of pool) {
      if (chosen.has(index)) continue;
      // Ties go to the earlier window, so the choice is deterministic.
      if (best === -1 || Math.abs(midpoint(index) - target) < Math.abs(midpoint(best) - target)) {
        best = index;
      }
    }
    chosen.add(best);
  }
  return pool.filter((index) => chosen.has(index));
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
