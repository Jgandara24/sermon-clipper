/** Controlled activation after migrations and operational acceptance. Never infer it from artifact presence. */
export function rangeExportsEnabled(): boolean {
  return process.env.P4_RANGE_EXPORTS_ENABLED === "true";
}
