/**
 * The one Phase 1 lab switch left (docs/PHASE1_LAB_PLAN.md): transcript reuse, which copies an
 * earlier lab transcript instead of paying the provider again. Set only by `npm run lab:worker`
 * and always off in production. The other lab steps became the selection steps in
 * src/lib/analysis/selection-steps.ts, with settings production can read.
 *
 * Kept out of env.ts on purpose: it is a lab switch, not a setting. Production must never read
 * it, and the guard below is the whole point.
 */
const LAB_SWITCHES = {
  transcriptReuse: "LAB_TRANSCRIPT_REUSE_ENABLED",
} as const;

export function labStepEnabled(step: keyof typeof LAB_SWITCHES): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env[LAB_SWITCHES[step]] === "true";
}
