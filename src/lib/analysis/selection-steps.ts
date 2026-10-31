import { spawnSync } from "node:child_process";
import type { Env } from "@/lib/env";

/**
 * The selection steps (docs/SELECTION_STEPS_SETTINGS_PLAN.md): the Phase 1 lab steps that run on
 * ANALYZE's ranked clips and on an EXPORT's render. A step runs only when two gates agree. The
 * environment gate, one `*_ENABLED` variable per step in src/lib/env.ts, says the environment
 * can run it. The workspace gate, `Workspace.settings.selectionSteps`, says this church gets it.
 * Both default to off, so a deploy changes nothing until an operator sets both. Two steps also
 * need the detector Python (`DETECTOR_PYTHON`, OpenCV and YuNet); without it they count as off.
 *
 * Nothing here reads NODE_ENV. That special case is what kept the lab steps unreachable in
 * production, and it is gone on purpose. The fail-open and fail-closed behaviour inside each
 * step lives with the step, not here.
 */

export const SELECTION_STEPS = [
  "sermonSpan",
  "boundaryStep",
  "dropoutCheck",
  "cameraCheck",
  "agreementRanking",
  "phraseCaptions",
  "speakerTracking",
] as const;

export type SelectionStep = (typeof SELECTION_STEPS)[number];

/** Each step's environment gate. The names describe the step, not the lab. */
export const SELECTION_STEP_VARIABLES = {
  sermonSpan: "ANALYSIS_SERMON_SPAN_ENABLED",
  boundaryStep: "ANALYSIS_BOUNDARY_STEP_ENABLED",
  dropoutCheck: "ANALYSIS_DROPOUT_CHECK_ENABLED",
  cameraCheck: "ANALYSIS_CAMERA_CHECK_ENABLED",
  agreementRanking: "ANALYSIS_AGREEMENT_RANKING_ENABLED",
  phraseCaptions: "EXPORT_PHRASE_CAPTIONS_ENABLED",
  speakerTracking: "EXPORT_SPEAKER_TRACKING_ENABLED",
} as const satisfies Record<SelectionStep, keyof Env>;

/** The steps that run the detector Python: scripts/lab/tracking/*.py through OpenCV. */
export const DETECTOR_STEPS: readonly SelectionStep[] = ["cameraCheck", "speakerTracking"];

/** The key in `Workspace.settings` that holds the workspace gate. */
export const SELECTION_STEPS_SETTINGS_KEY = "selectionSteps";

/** The environment gate's part of the typed env accessor; tests pass a plain object. */
export type SelectionStepsEnvironment = Partial<Pick<Env, (typeof SELECTION_STEP_VARIABLES)[SelectionStep]>>;

/** Why a step is off: the first gate that stopped it. */
export type SelectionStepOffReason = "environment" | "workspace" | "no-detector";

export type ResolvedSelectionStep =
  | { on: true; reason: null }
  | { on: false; reason: SelectionStepOffReason };

/** One answer per step, resolved once per job and recorded with it. */
export type ResolvedSelectionSteps = { readonly [K in SelectionStep]: ResolvedSelectionStep };

export type SelectionStepsSettings = { readonly [K in SelectionStep]: boolean };

/** A fail-open step that failed for every clip of one job: the church got clips without it. */
export type SelectionStepDegradation = { step: SelectionStep; detail: string };

function objectAt(value: unknown, key: string): Record<string, unknown> {
  const section =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : null;
  return section && typeof section === "object" && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : {};
}

/**
 * The workspace gate, read from `Workspace.settings`. A missing key or a missing step means off,
 * and only the boolean true turns a step on: a stored string "true" is a configuration mistake,
 * not permission. Unknown keys are ignored.
 */
export function parseSelectionStepsSettings(settings: unknown): SelectionStepsSettings {
  const raw = objectAt(settings, SELECTION_STEPS_SETTINGS_KEY);
  const parsed = {} as Record<SelectionStep, boolean>;
  for (const step of SELECTION_STEPS) parsed[step] = raw[step] === true;
  return parsed;
}

/**
 * The operator script's change to the workspace gate, as a pure function on the settings JSON.
 * Other settings sections and unknown keys inside `selectionSteps` stay as they are.
 */
export function applySelectionStepsChange(
  settings: Record<string, unknown>,
  change: { on: readonly SelectionStep[]; off: readonly SelectionStep[] },
): Record<string, unknown> {
  const section = { ...objectAt(settings, SELECTION_STEPS_SETTINGS_KEY) };
  for (const step of change.on) section[step] = true;
  for (const step of change.off) section[step] = false;
  return { ...settings, [SELECTION_STEPS_SETTINGS_KEY]: section };
}

/**
 * Pure. Joins the two gates and the detector path into one answer per step. The reason is the
 * first gate that said no: environment, then workspace, then the detector.
 */
export function resolveSelectionSteps(input: {
  environment: SelectionStepsEnvironment;
  workspaceSettings: unknown;
  /** The detector Python when it is present and runs; undefined otherwise. */
  detectorPython: string | undefined;
}): ResolvedSelectionSteps {
  const workspace = parseSelectionStepsSettings(input.workspaceSettings);
  const resolved = {} as Record<SelectionStep, ResolvedSelectionStep>;
  for (const step of SELECTION_STEPS) {
    if (input.environment[SELECTION_STEP_VARIABLES[step]] !== true) {
      resolved[step] = { on: false, reason: "environment" };
    } else if (!workspace[step]) {
      resolved[step] = { on: false, reason: "workspace" };
    } else if (DETECTOR_STEPS.includes(step) && !input.detectorPython) {
      resolved[step] = { on: false, reason: "no-detector" };
    } else {
      resolved[step] = { on: true, reason: null };
    }
  }
  return resolved;
}

/** The steps that are on, in the fixed order, for a message. */
export function selectionStepsOn(steps: ResolvedSelectionSteps): SelectionStep[] {
  return SELECTION_STEPS.filter((step) => steps[step].on);
}

export type PythonImportsOpenCv = (python: string) => boolean;

/** Runs `import cv2` under the given Python. Thirty seconds is generous for an import. */
export function defaultPythonImportsOpenCv(python: string): boolean {
  const result = spawnSync(python, ["-c", "import cv2"], { stdio: "ignore", timeout: 30_000 });
  return result.status === 0;
}

/**
 * The detector Python for one job: the configured path when it is set and imports OpenCV, else
 * undefined, so the resolver turns the detector steps off with the reason `no-detector`. A
 * missing or broken runtime is one alert, not one failed clip at a time.
 */
export function availableDetectorPython(
  configured: string | undefined,
  pythonImportsOpenCv: PythonImportsOpenCv = defaultPythonImportsOpenCv,
): string | undefined {
  if (!configured) return undefined;
  return pythonImportsOpenCv(configured) ? configured : undefined;
}

export type DetectorRuntimeCheck = {
  /** `not-needed`: no detector step is on in the environment gate, so nothing to check. */
  status: "not-needed" | "ok" | "missing" | "broken";
  /** The detector steps the environment gate turns on. */
  steps: SelectionStep[];
  detectorPython: string | null;
  message: string;
};

/**
 * The worker's boot check. When the environment gate turns on a detector step and the Python is
 * absent (`missing`) or cannot import OpenCV (`broken`), the worker records one
 * selection_steps_unavailable event with severity error, so a missing runtime is one alert at
 * boot instead of a surprise on the first sermon.
 */
export function checkDetectorRuntime(
  input: { environment: SelectionStepsEnvironment; detectorPython: string | undefined },
  pythonImportsOpenCv: PythonImportsOpenCv = defaultPythonImportsOpenCv,
): DetectorRuntimeCheck {
  const steps = DETECTOR_STEPS.filter((step) => input.environment[SELECTION_STEP_VARIABLES[step]] === true);
  const detectorPython = input.detectorPython ?? null;
  const named = steps.join(" and ");
  if (steps.length === 0) {
    return { status: "not-needed", steps, detectorPython, message: "No selection step needs the detector Python." };
  }
  if (!detectorPython) {
    return {
      status: "missing",
      steps,
      detectorPython,
      message: `DETECTOR_PYTHON is not set, so ${named} count as off until it is.`,
    };
  }
  if (!pythonImportsOpenCv(detectorPython)) {
    return {
      status: "broken",
      steps,
      detectorPython,
      message: `The detector Python at ${detectorPython} cannot import OpenCV, so ${named} count as off until it can.`,
    };
  }
  return { status: "ok", steps, detectorPython, message: `The detector Python at ${detectorPython} imports OpenCV.` };
}
