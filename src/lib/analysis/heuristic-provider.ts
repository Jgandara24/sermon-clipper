import { computeCompleteness, computePlatformFit, computeSpeakerEnergy } from "./computed-subscores";
import { computeTotal, scoreToLetter } from "./scoring";
import type {
  AnalysisCandidate,
  AnalysisContext,
  AnalysisProvider,
  ScoredCandidate,
  Subscore,
} from "./types";

const EMOTION_LEXICON = new Set([
  "hope", "peace", "joy", "fear", "struggle", "anxious", "love", "forgive",
  "grace", "hurt", "heal", "broken", "victory", "faith", "trust", "prayer",
  "pain", "fight", "overcome", "afraid", "comfort",
]);

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "to", "of",
  "in", "on", "for", "with", "that", "this", "it", "as", "at", "by", "be",
  "have", "has", "had", "not", "i", "you", "he", "she", "they", "we", "his",
  "her", "their", "our", "your",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function subscore(score: number, note: string): Subscore {
  const rounded = Math.round(score);
  return { score: rounded, letter: scoreToLetter(rounded), note };
}

function buildTitle(text: string): string {
  const firstSentence = text.split(/[.!?]/)[0]?.trim() ?? text;
  const words = firstSentence.split(/\s+/);
  const title = words.slice(0, 8).join(" ");
  return title.length > 0 ? `${title}${words.length > 8 ? "…" : ""}` : "Untitled clip";
}

/**
 * Real, deterministic, non-LLM scoring — the default fallback so a fresh clone (no
 * ANTHROPIC_API_KEY) still produces genuinely computed rankings rather than a stub. Labeled
 * "heuristic-v1" throughout, never presented as AI-scored. See DECISIONS.md.
 */
export class HeuristicAnalysisProvider implements AnalysisProvider {
  readonly name = "heuristic";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async scoreCandidates(
    candidates: AnalysisCandidate[],
    context: AnalysisContext,
  ): Promise<ScoredCandidate[]> {
    const videoTokens = tokenize(context.fullText).filter((w) => !STOPWORDS.has(w));
    const videoFreq = new Map<string, number>();
    for (const token of videoTokens) {
      videoFreq.set(token, (videoFreq.get(token) ?? 0) + 1);
    }
    const topVideoWords = new Set(
      [...videoFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([word]) => word),
    );

    return candidates.map((candidate) => {
      const durationS = (candidate.endMs - candidate.startMs) / 1000;
      const words = tokenize(candidate.text);
      const wordCount = words.length;

      const platformFit = computePlatformFit(durationS);
      const speakerEnergy = computeSpeakerEnergy(wordCount, durationS);
      const completeness = computeCompleteness(wordCount);

      const firstSentence = candidate.text.split(/[.!?]/)[0] ?? "";
      const firstWords = tokenize(firstSentence);
      const hasQuestion = candidate.text.trim().slice(0, 60).includes("?");
      const hookStrength = subscore(
        clamp(50 + (hasQuestion ? 20 : 0) + (firstWords.length > 0 && firstWords.length <= 10 ? 15 : 0)),
        "First words grab attention quickly.",
      );

      const emotionHits = words.filter((w) => EMOTION_LEXICON.has(w)).length;
      const emotionDensity = wordCount > 0 ? emotionHits / wordCount : 0;
      const emotionalImpact = subscore(
        clamp(55 + emotionDensity * 400),
        emotionHits > 0 ? "Uses emotionally resonant language." : "Even in tone; few emotional cues detected.",
      );
      const shareability = subscore(
        clamp(50 + emotionDensity * 350 + (hasQuestion ? 10 : 0)),
        "Estimated from emotional language and hook cues.",
      );

      const opensWithPronoun = /^(it|this|that|he|she|they|so|and|but)\b/i.test(candidate.text.trim());
      const clarity = subscore(
        clamp(opensWithPronoun ? 62 : 86),
        opensWithPronoun ? "Opens with a pronoun that may need context." : "Stands on its own without earlier context.",
      );

      const uniqueWords = new Set(words.filter((w) => !STOPWORDS.has(w)));
      const overlap = [...uniqueWords].filter((w) => topVideoWords.has(w)).length;
      const topicRelevance = subscore(
        clamp(50 + overlap * 8),
        "Compared against the video's most common words.",
      );

      const subscores = {
        hook_strength: hookStrength,
        clarity,
        emotional_impact: emotionalImpact,
        completeness,
        shareability,
        speaker_energy: speakerEnergy,
        topic_relevance: topicRelevance,
        platform_fit: platformFit,
      };

      return {
        startMs: candidate.startMs,
        endMs: candidate.endMs,
        text: candidate.text,
        title: buildTitle(candidate.text),
        hookText: firstSentence.trim().slice(0, 60) || candidate.text.slice(0, 60),
        summary:
          "Heuristic scoring (no AI analysis configured): ranked by pacing, hook cues, and " +
          "emotional language density, not by an LLM reading the content.",
        excerpt: candidate.text.slice(0, 200),
        total: computeTotal(subscores),
        subscores,
        modelVersion: "heuristic-v1",
      };
    });
  }
}
