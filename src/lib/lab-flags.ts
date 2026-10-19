/**
 * Phase 1 lab switches (docs/PHASE1_LAB_PLAN.md). Set only by `npm run lab:worker`; always off in
 * production. Kept out of env.ts on purpose: many tests replace that module wholesale, and a lab
 * switch must read as off there rather than throw.
 */
const LAB_SWITCHES = {
  speakerTracking: "LAB_SPEAKER_TRACKING_ENABLED",
  cameraCheck: "LAB_CAMERA_CHECK_ENABLED",
  boundaryStep: "LAB_BOUNDARY_STEP_ENABLED",
  phraseCaptions: "LAB_PHRASE_CAPTIONS_ENABLED",
} as const;

export function labStepEnabled(step: keyof typeof LAB_SWITCHES): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env[LAB_SWITCHES[step]] === "true";
}

/** The Python that has OpenCV and YuNet for the lab detectors (Codex's tracking venv). */
export function labTrackingPython(): string {
  return process.env.LAB_TRACKING_PYTHON || "/Users/jakegandara/ai-runtimes/p4-speaker-tracking-py313/bin/python";
}
