import { z } from "zod";
import { sourceIntervalSchema } from "@/lib/media-artifacts/types";
import { proxyViewRequestSchema } from "./proxy-views";

export const proxyViewSamplingSchema = z.object({
  sourceInterval: sourceIntervalSchema,
  count: z.number().int().min(1).max(64), maxDistanceMs: z.number().int().nonnegative().safe(),
}).strict();
export const proxyViewPlanRequestSchema = z.union([proxyViewRequestSchema,
  proxyViewRequestSchema.omit({ sourceTimesMs: true }).extend({ sampling: proxyViewSamplingSchema }).strict()]);
export type ProxyViewPlanRequest = z.infer<typeof proxyViewPlanRequestSchema>;

/** Even target spacing over a half-open interval. Choose observed frames only; ties choose the earlier frame. */
export function sampleProxyViewFrames(observedInput: number[], samplingInput: z.infer<typeof proxyViewSamplingSchema>) {
  const sampling = proxyViewSamplingSchema.parse(samplingInput);
  const observed = z.array(z.number().int().nonnegative().safe()).min(1).parse(observedInput);
  if (observed.some((time, index) => index > 0 && time <= observed[index - 1])) throw new Error("PROXY_VIEW_OBSERVATIONS_UNORDERED");
  const { startMs, endMs } = sampling.sourceInterval;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) throw new Error("PROXY_VIEW_INTERVAL_UNSAFE");
  const eligible = observed.filter(time => time >= startMs && time < endMs);
  if (eligible.length < sampling.count) throw new Error("PROXY_VIEW_INSUFFICIENT_OBSERVATIONS");
  const span = BigInt(endMs) - BigInt(startMs) - BigInt(1);
  const targets = Array.from({ length: sampling.count }, (_, index) => Number(BigInt(startMs) +
    (sampling.count === 1 ? span / BigInt(2) : span * BigInt(index) / BigInt(sampling.count - 1))));
  let cursor = 0;
  const selections = targets.map(targetMs => {
    while (cursor + 1 < eligible.length && Math.abs(eligible[cursor + 1] - targetMs) < Math.abs(eligible[cursor] - targetMs)) cursor++;
    const sourceTimeMs = eligible[cursor], distanceMs = Math.abs(sourceTimeMs - targetMs);
    if (distanceMs > sampling.maxDistanceMs) throw new Error("PROXY_VIEW_SAMPLING_DISTANCE_EXCEEDED");
    return { targetMs, sourceTimeMs, distanceMs };
  });
  if (new Set(selections.map(item => item.sourceTimeMs)).size !== selections.length) throw new Error("PROXY_VIEW_SAMPLING_DUPLICATE");
  return { version: "observed-proxy-sampling-v1", policy: "uniform-targets-nearest-observed-earlier-tie",
    sampling, selections, sourceTimesMs: selections.map(item => item.sourceTimeMs) };
}
