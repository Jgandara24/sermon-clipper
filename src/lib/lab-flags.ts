/**
 * Phase 1 lab switches (docs/PHASE1_LAB_PLAN.md). Set only by `npm run lab:worker`; always off in
 * production. Kept out of env.ts on purpose: many tests replace that module wholesale, and a lab
 * switch must read as off there rather than throw.
 */
export function labStepEnabled(step: "speakerTracking" | "cameraCheck" | "boundaryStep"): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const name =
    step === "speakerTracking"
      ? "LAB_SPEAKER_TRACKING_ENABLED"
      : step === "cameraCheck"
        ? "LAB_CAMERA_CHECK_ENABLED"
        : "LAB_BOUNDARY_STEP_ENABLED";
  return process.env[name] === "true";
}

/** The Python that has OpenCV and YuNet for the lab detectors (Codex's tracking venv). */
export function labTrackingPython(): string {
  return process.env.LAB_TRACKING_PYTHON || "/Users/jakegandara/ai-runtimes/p4-speaker-tracking-py313/bin/python";
}
