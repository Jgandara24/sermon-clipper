import { createHash } from "node:crypto";

/** JSONB reorders object keys. Proof hashes must not depend on insertion order. */
export function rangeEvidenceSha256(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(canonical);
    if (typeof item === "object" && item !== null) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, canonical(entry)]));
    }
    throw new Error("RANGE_EVIDENCE_REQUIRES_JSON");
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
