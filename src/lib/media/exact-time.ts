import { z } from "zod";

/** Exact nonnegative milliseconds. Fraction strings avoid JSON and floating-point precision loss. */
export const exactTimeMsSchema = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.object({ numerator: z.string().max(128).regex(/^(0|[1-9]\d*)$/),
    denominator: z.string().max(128).regex(/^[1-9]\d*$/) }).strict(),
]).refine(value => typeof value === "number" ||
  BigInt(value.numerator) <= BigInt(Number.MAX_SAFE_INTEGER) * BigInt(value.denominator),
"Timestamp exceeds safe source bounds.");
export type ExactTimeMs = z.infer<typeof exactTimeMsSchema>;

function parts(value: ExactTimeMs): [bigint, bigint] {
  const parsed = exactTimeMsSchema.parse(value);
  return typeof parsed === "number" ? [BigInt(parsed), BigInt(1)] : [BigInt(parsed.numerator), BigInt(parsed.denominator)];
}
export function exactTimeMs(numerator: bigint, denominator: bigint): ExactTimeMs {
  if (numerator < BigInt(0) || denominator <= BigInt(0) ||
      numerator > BigInt(Number.MAX_SAFE_INTEGER) * denominator) throw new Error("EXACT_TIME_OUTSIDE_BOUNDS");
  let a = numerator, b = denominator;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  numerator /= a; denominator /= a;
  return denominator === BigInt(1) ? Number(numerator) : exactTimeMsSchema.parse({
    numerator: numerator.toString(), denominator: denominator.toString(),
  });
}
export function normalizeTimeMs(value: ExactTimeMs) { return exactTimeMs(...parts(value)); }
export function compareTimeMs(left: ExactTimeMs, right: ExactTimeMs) {
  const [ln, ld] = parts(left), [rn, rd] = parts(right);
  const difference = ln * rd - rn * ld;
  return difference < BigInt(0) ? -1 : difference > BigInt(0) ? 1 : 0;
}
export function addTimeMs(left: ExactTimeMs, right: ExactTimeMs) {
  const [ln, ld] = parts(left), [rn, rd] = parts(right);
  return exactTimeMs(ln * rd + rn * ld, ld * rd);
}
export function subtractTimeMs(left: ExactTimeMs, right: ExactTimeMs) {
  const [ln, ld] = parts(left), [rn, rd] = parts(right);
  return exactTimeMs(ln * rd - rn * ld, ld * rd);
}
