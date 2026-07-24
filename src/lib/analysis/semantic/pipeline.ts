import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { dedupByOverlap, refineBoundaries, type TranscriptSegmentInput } from "../chunking";
import {
  scoreSectionCandidates,
  type SectionScoringCandidate,
} from "../claude-provider";
import { generateSermonOutline } from "../outline/claude-outline";
import type { SermonOutlineDraft } from "../outline/types";
import type { AnalysisModelCall } from "../usage";
import type { ScoredCandidate } from "../types";
import { applyVisualGate, type VideoSource, type VisualGateStatus } from "../visual-gate";
import { discoverSectionMoments, type DiscoveredMoment } from "./discovery";
import { resolveMomentAnchors, type ResolvedCandidate } from "./resolve";
import { selectWithSectionDiversity } from "./selection";

// Section scoring shares Stage B's payload budget — same schema, same token cap.
const MAX_SCORING_CANDIDATES = 25;

export type SemanticClip = ScoredCandidate & { sectionPosition: number | null };

export type SemanticPipelineOutput = {
  /** Always present — the reliability ladder guarantees at least a single-section outline. */
  outline: SermonOutlineDraft;
  /**
   * Final clips in global rank order, or null when the caller must fall back to the
   * candidate-window pipeline (outline/discovery failed). An empty array is NOT a fallback
   * signal: it means the eligibility gates rejected everything, and fail-closed beats shipping
   * ungated clips.
   */
  clips: SemanticClip[] | null;
  fallbackReason: string | null;
  calls: AnalysisModelCall[];
  visualGateStatus: VisualGateStatus | "not_run";
  diagnostics: {
    sections: number;
    momentsDiscovered: number;
    resolvedCandidates: number;
    scoredCandidates: number;
    visualRejected: number;
  };
};

export function semanticPipelineEnabled(): boolean {
  return (env.ANALYSIS_SEMANTIC_OUTLINE || "on").toLowerCase() !== "off";
}

function visualGateEnabled(): boolean {
  return (env.ANALYSIS_VISUAL_GATE || "on").toLowerCase() !== "off";
}

/**
 * The outline-first analysis path (primary since the semantic-pipeline revision; the evenly
 * distributed candidate-window path remains the fallback): sermon outline → per-section moment
 * discovery → deterministic anchor resolution with the content gate → context-aware scoring →
 * visual gate → diversity-aware selection. Never persists anything — the ANALYZE handler owns
 * persistence and the fallback decision.
 */
export async function runSemanticPipeline(input: {
  segments: TranscriptSegmentInput[];
  fullText: string;
  genre: string;
  sourceDurationMs: number;
  maxClips: number;
  minMs: number;
  maxMs: number;
  video: VideoSource | null;
}): Promise<SemanticPipelineOutput> {
  const client = env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  const { draft: outline, calls } = await generateSermonOutline(input.segments, client);

  const fallback = (reason: string, diagnostics?: Partial<SemanticPipelineOutput["diagnostics"]>): SemanticPipelineOutput => ({
    outline,
    clips: null,
    fallbackReason: reason,
    calls,
    visualGateStatus: "not_run",
    diagnostics: {
      sections: outline.sections.length,
      momentsDiscovered: 0,
      resolvedCandidates: 0,
      scoredCandidates: 0,
      visualRejected: 0,
      ...diagnostics,
    },
  });

  // The semantic path needs the AI outline; a heuristic or single-section outline still
  // persists (the UI shows it and the fallback pipeline's clips attach to it), but moment
  // discovery on top of guessed section boundaries isn't worth its cost or failure modes.
  if (!client) return fallback("provider_unavailable");
  if (outline.status !== "generated") return fallback(`outline_${outline.status}`);

  const segmentsBySectionPosition = new Map(
    outline.sections.map((section) => [
      section.position,
      input.segments.filter(
        (s) => s.idx >= section.startSegmentIdx && s.idx <= section.endSegmentIdx,
      ),
    ]),
  );

  // Every section is searched independently; one section's failed discovery call must not
  // starve the rest, so failures degrade to "no moments found in that section".
  const momentsPerSection = await Promise.all(
    outline.sections.map(async (section): Promise<DiscoveredMoment[]> => {
      try {
        return await discoverSectionMoments(
          client,
          section,
          segmentsBySectionPosition.get(section.position) ?? [],
          { mainIdea: outline.mainIdea, minMs: input.minMs, maxMs: input.maxMs },
          calls,
        );
      } catch {
        return [];
      }
    }),
  );
  const moments = momentsPerSection.flat();
  if (moments.length === 0) return fallback("discovery_empty");

  const resolved = resolveMomentAnchors(moments, input.segments, {
    minMs: input.minMs,
    maxMs: input.maxMs,
    exclusions: outline.exclusions,
  });
  if (resolved.length === 0) {
    return fallback("no_resolvable_moments", { momentsDiscovered: moments.length });
  }

  const capped = roundRobinBySection(resolved, MAX_SCORING_CANDIDATES);
  const sectionByPosition = new Map(outline.sections.map((s) => [s.position, s]));
  const scoringCandidates: SectionScoringCandidate[] = capped.map((candidate) => {
    const section = sectionByPosition.get(candidate.sectionPosition);
    return {
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      text: candidate.text,
      sectionHeading: section?.heading ?? "Main Message",
      sectionType: section?.type ?? "main_message",
      sectionSummary: section?.summary ?? "",
      momentType: candidate.momentType,
    };
  });

  const scored = await scoreSectionCandidates(
    client,
    scoringCandidates,
    { fullText: input.fullText, genre: input.genre, mainIdea: outline.mainIdea, sermonTitle: outline.generatedTitle },
    calls,
  );
  if (scored.length === 0) return fallback("scoring_empty", { momentsDiscovered: moments.length, resolvedCandidates: resolved.length });

  const withSections: SemanticClip[] = scored.map(({ candidateIndex, ...clip }) => ({
    ...clip,
    sectionPosition: capped[candidateIndex]?.sectionPosition ?? null,
  }));

  const refined = withSections.map((clip) => refineBoundaries(clip, input.sourceDurationMs));
  const deduped = dedupByOverlap(
    refined.map((clip) => ({ ...clip, score: clip.total })),
    0.5,
  );

  const gate = await applyVisualGate(deduped, input.video, {
    client,
    minMs: input.minMs,
    enabled: visualGateEnabled(),
  });
  calls.push(...gate.calls);
  // Rejected ranges become diagnostics on the outline so a rejected span is inspectable later.
  outline.exclusions = [...outline.exclusions, ...gate.rejected.map((r) => r.exclusion)].sort(
    (a, b) => a.startMs - b.startMs,
  );

  const selected = selectWithSectionDiversity(gate.passed, input.maxClips);

  return {
    outline,
    clips: selected,
    fallbackReason: null,
    calls,
    visualGateStatus: gate.status,
    diagnostics: {
      sections: outline.sections.length,
      momentsDiscovered: moments.length,
      resolvedCandidates: resolved.length,
      scoredCandidates: scored.length,
      visualRejected: gate.rejected.length,
    },
  };
}

/**
 * Caps the scoring payload while keeping every section represented: takes candidates in
 * rotation across sections (each section's candidates in discovery order) until the cap.
 */
export function roundRobinBySection(
  candidates: ResolvedCandidate[],
  cap: number,
): ResolvedCandidate[] {
  if (candidates.length <= cap) return candidates;
  const bySection = new Map<number, ResolvedCandidate[]>();
  for (const candidate of candidates) {
    const list = bySection.get(candidate.sectionPosition) ?? [];
    list.push(candidate);
    bySection.set(candidate.sectionPosition, list);
  }
  const queues = [...bySection.entries()].sort(([a], [b]) => a - b).map(([, list]) => list);
  const taken: ResolvedCandidate[] = [];
  let round = 0;
  while (taken.length < cap) {
    let tookAny = false;
    for (const queue of queues) {
      if (taken.length >= cap) break;
      if (round < queue.length) {
        taken.push(queue[round]);
        tookAny = true;
      }
    }
    if (!tookAny) break;
    round += 1;
  }
  return taken;
}
