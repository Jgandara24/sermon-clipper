import { z } from "zod";
import { sourceIntervalSchema, sha256Schema } from "@/lib/media-artifacts/types";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { mediaRegionSchema, slideSubtypeSchema } from "./types";

const sourceIdentity = z.object({ sourceVideoId: z.string().uuid(), sourceSha256: sha256Schema }).strict();
export const slideEvaluationSchema = z.object({
  datasetId: z.string().min(1),
  sources: z.array(sourceIdentity.extend({
    reviewReference: z.string().min(1),
    reviewedIntervals: z.array(sourceIntervalSchema).min(1),
    slides: z.array(z.object({ sourceInterval: sourceIntervalSchema, subtype: slideSubtypeSchema }).strict()),
  }).strict()).min(1),
  runs: z.array(z.object({ detectorVersion: z.string().min(1), configurationSha256: sha256Schema,
    completedSources: z.array(sourceIdentity).min(1), facts: z.array(mediaRegionSchema),
  }).strict()).min(1),
}).strict();
type Interval = z.infer<typeof sourceIntervalSchema>;

function union(spans: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    const last = result.at(-1);
    if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs);
    else result.push({ ...span });
  }
  return result;
}
function intersect(a: Interval[], b: Interval[]): Interval[] {
  const result: Interval[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const startMs = Math.max(a[i].startMs, b[j].startMs), endMs = Math.min(a[i].endMs, b[j].endMs);
    if (startMs < endMs) result.push({ startMs, endMs });
    if (a[i].endMs < b[j].endMs) i++; else j++;
  }
  return result;
}
function sum(values: number[]) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) throw new Error("SLIDE_EVALUATION_DURATION_OVERFLOW");
  return total;
}
const duration = (spans: Interval[]) => sum(spans.map(span => span.endMs - span.startMs));
const identity = (source: z.infer<typeof sourceIdentity>) => `${source.sourceVideoId}:${source.sourceSha256}`;
function metrics(values: { labeledMs: number; predictedMs: number; matchedMs: number }[]) {
  const labeledMs = sum(values.map(value => value.labeledMs));
  const predictedMs = sum(values.map(value => value.predictedMs));
  const matchedMs = sum(values.map(value => value.matchedMs));
  return { labeledMs, predictedMs, matchedMs, missedMs: labeledMs - matchedMs,
    falsePositiveMs: predictedMs - matchedMs, recall: labeledMs ? matchedMs / labeledMs : null,
    precision: predictedMs ? matchedMs / predictedMs : null };
}

/** Duration-weighted evaluation within explicitly reviewed intervals. This never authorizes production activation. */
export function evaluateSlides(value: unknown) {
  const input = slideEvaluationSchema.parse(value);
  const sourceIds = new Set(input.sources.map(source => source.sourceVideoId));
  if (sourceIds.size !== input.sources.length) throw new Error("SLIDE_EVALUATION_DUPLICATE_SOURCE");
  const sourceKeys = new Set(input.sources.map(identity));
  const runKeys = new Set(input.runs.map(run => `${run.detectorVersion}:${run.configurationSha256}`));
  if (runKeys.size !== input.runs.length) throw new Error("SLIDE_EVALUATION_DUPLICATE_RUN");
  for (const source of input.sources) {
    const coverage = union(source.reviewedIntervals);
    for (const slide of source.slides) {
      if (duration(intersect([slide.sourceInterval], coverage)) !== duration([slide.sourceInterval])) {
        throw new Error("SLIDE_EVALUATION_LABEL_OUTSIDE_REVIEW");
      }
    }
    const labels = [...source.slides].sort((a, b) => a.sourceInterval.startMs - b.sourceInterval.startMs);
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].sourceInterval.startMs < labels[i - 1].sourceInterval.endMs) throw new Error("SLIDE_EVALUATION_OVERLAPPING_LABELS");
    }
  }
  const runs = input.runs.map(run => {
    const completed = new Set(run.completedSources.map(identity));
    if (completed.size !== run.completedSources.length || completed.size !== sourceKeys.size ||
      [...completed].some(key => !sourceKeys.has(key))) throw new Error("SLIDE_EVALUATION_INCOMPLETE_RUN");
    if (run.facts.some(fact => !sourceKeys.has(identity(fact)) || fact.detectorVersion !== run.detectorVersion ||
      fact.configurationSha256 !== run.configurationSha256)) throw new Error("SLIDE_EVALUATION_FACT_IDENTITY_MISMATCH");
    const bySource = input.sources.map(source => {
      const coverage = union(source.reviewedIntervals);
      const facts = run.facts.filter(fact => fact.sourceVideoId === source.sourceVideoId && fact.kind === "FULLSCREEN_SLIDE");
      const score = (subtype?: z.infer<typeof slideSubtypeSchema>) => {
        const labels = union(source.slides.filter(slide => !subtype || slide.subtype === subtype).map(slide => slide.sourceInterval));
        const predictions = intersect(union(facts.filter(fact => !subtype || fact.slideSubtype === subtype).map(fact => fact.sourceInterval)), coverage);
        return metrics([{ labeledMs: duration(labels), predictedMs: duration(predictions), matchedMs: duration(intersect(labels, predictions)) }]);
      };
      return { sourceVideoId: source.sourceVideoId, sourceSha256: source.sourceSha256, reviewReference: source.reviewReference,
        reviewedMs: duration(coverage), allSlides: score(),
        bySubtype: slideSubtypeSchema.options.map(subtype => ({ subtype, ...score(subtype) })) };
    });
    const allSlides = metrics(bySource.map(source => source.allSlides));
    return { detectorVersion: run.detectorVersion, configurationSha256: run.configurationSha256,
      reviewedMs: sum(bySource.map(source => source.reviewedMs)), allSlides,
      recallTarget: 0.9, recallTargetMet: allSlides.recall === null ? null : allSlides.recall >= 0.9,
      bySubtype: slideSubtypeSchema.options.map(subtype => ({ subtype,
        ...metrics(bySource.map(source => source.bySubtype.find(score => score.subtype === subtype)!)) })), bySource };
  });
  return { version: "slide-duration-evaluation-v1", datasetId: input.datasetId, inputSha256: rangeEvidenceSha256(input),
    sourceCount: input.sources.length, productionApproval: "not_evaluated", runs };
}
