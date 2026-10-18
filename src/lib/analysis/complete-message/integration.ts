import { z } from "zod";
import { POLICY, transcriptSchema, type Transcript } from "./contract";

export class CompleteMessageFailure extends Error {
  constructor(readonly reason: string) { super(`Complete-message analysis stopped: ${reason}`); }
}

const settingSchema = z.object({
  enabled: z.literal(true), version: z.literal(POLICY.version),
  evidence: z.object({
    revision: z.string().min(1),
    regions: transcriptSchema.shape.regions,
    gaps: transcriptSchema.shape.gaps,
  }).strict(),
}).strict();

/** Absence and explicit false retain the original path. No environment variable enables this policy. */
export function readCompleteMessagePolicy(config: unknown): z.infer<typeof settingSchema> | null {
  if (!config || typeof config !== "object" || !("completeMessagePolicy" in config)) return null;
  const setting = config.completeMessagePolicy;
  if (setting && typeof setting === "object" && "enabled" in setting && setting.enabled === false) return null;
  const parsed = settingSchema.safeParse(setting);
  if (!parsed.success) throw new CompleteMessageFailure("invalid_policy_snapshot");
  return parsed.data;
}

const storedWords = z.array(z.object({ word: z.string().min(1), startMs: z.number(), endMs: z.number() }));
type SourceInput = {
  durationMs: number | null; transcriptRevision: number;
  transcript: {
    id: string; updatedAt: Date;
    segments: Array<{ id: string; startMs: number; endMs: number; text: string; words: unknown }>;
  };
};

export function sourceRevision(source: SourceInput): string {
  return `${source.transcript.id}:${source.transcriptRevision}:${source.transcript.updatedAt.toISOString()}`;
}

/** Evidence must belong to this exact transcript. No source text or region clearance is invented. */
export function prepareCompleteMessageTranscript(source: SourceInput, setting: z.infer<typeof settingSchema>): Transcript {
  const revision = sourceRevision(source);
  if (setting.evidence.revision !== revision) throw new CompleteMessageFailure("stale_region_evidence");
  const segments = source.transcript.segments.map((segment) => {
    const parsed = storedWords.safeParse(segment.words);
    if (!parsed.success) throw new CompleteMessageFailure("invalid_source_words");
    return {
      id: segment.id, startMs: segment.startMs, endMs: segment.endMs, text: segment.text,
      // These identifiers match the editor's segment:index convention.
      words: parsed.data.map((word, i) => ({ id: `${segment.id}:${i}`, text: word.word, startMs: word.startMs, endMs: word.endMs })),
    };
  });
  const parsed = transcriptSchema.safeParse({
    revision, sourceDurationMs: source.durationMs, segments,
    regions: setting.evidence.regions, gaps: setting.evidence.gaps,
  });
  if (!parsed.success) throw new CompleteMessageFailure("invalid_transcript");
  return parsed.data;
}
