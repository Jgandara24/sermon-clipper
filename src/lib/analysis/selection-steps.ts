import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Env } from "@/lib/env";

const execFile = promisify(execFileCallback);

/**
 * The selection steps (docs/SELECTION_STEPS_SETTINGS_PLAN.md): the Phase 1 lab steps that run on
 * ANALYZE's ranked clips and on an EXPORT's render. A step runs only when two gates agree. The
 * environment gate, one `*_ENABLED` variable per step in src/lib/env.ts, says the environment
 * can run it. The workspace gate, `Workspace.settings.selectionSteps`, says this church gets it.
 * Both default to off, so a deploy changes nothing until an operator sets both. Two steps also
 * need the detector: the Python at `DETECTOR_PYTHON` (OpenCV and YuNet) and the scripts in
 * scripts/lab/tracking/. Without them, those two count as off.
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

function gatesAgree(step: SelectionStep, environment: SelectionStepsEnvironment, workspace: SelectionStepsSettings): boolean {
  return environment[SELECTION_STEP_VARIABLES[step]] === true && workspace[step];
}

/** The detector scripts the two steps run, relative to the worker's working directory. */
export const DETECTOR_SCRIPTS = {
  cameraSample: "scripts/lab/tracking/camera-sample.py",
  observePeople: "scripts/lab/tracking/observe-people.py",
  observeFaces: "scripts/lab/tracking/observe-faces.py",
} as const;

export type DetectorScript = keyof typeof DETECTOR_SCRIPTS;

/** One detector script's absolute path. The worker needs the scripts as well as the Python. */
export function detectorScriptPath(script: DetectorScript, root: string = process.cwd()): string {
  return path.resolve(root, DETECTOR_SCRIPTS[script]);
}

/** Why the detector cannot run, as a clause for a message ("... is missing"); null when it can. */
export type DetectorProbe = (python: string) => Promise<string | null>;

const PROBE_TIMEOUT_MS = 30_000;

/**
 * The default probe: every detector script is present, and `import cv2` succeeds under the given
 * Python. Thirty seconds is generous for an import. The answer names the cause, because "cannot
 * import OpenCV" is the wrong alert for a path that does not exist or an image without the scripts.
 */
export async function defaultDetectorProbe(python: string, root: string = process.cwd()): Promise<string | null> {
  for (const script of Object.keys(DETECTOR_SCRIPTS) as DetectorScript[]) {
    const scriptPath = detectorScriptPath(script, root);
    if (!existsSync(scriptPath)) return `the detector script ${scriptPath} is missing`;
  }
  try {
    await execFile(python, ["-c", "import cv2"], { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL" });
    return null;
  } catch (error) {
    const failure = error as { code?: string | number; killed?: boolean; stderr?: string };
    if (failure.killed) return `${python} did not finish "import cv2" within ${PROBE_TIMEOUT_MS / 1000} seconds`;
    if (typeof failure.code === "string") return `${python} did not start (${failure.code})`;
    const lastLine = (failure.stderr ?? "").trim().split("\n").pop() ?? "";
    return `${python} cannot import OpenCV${lastLine ? ` (${lastLine})` : ""}`;
  }
}

export type JobSelectionSteps = {
  steps: ResolvedSelectionSteps;
  /** The detector steps both gates turned on for this workspace. */
  detectorSteps: SelectionStep[];
  /** The detector Python the detector steps run with; undefined when none is on or it cannot run. */
  detectorPython: string | undefined;
  /** Why a detector step both gates turned on counts as off; null when none is on or it runs. */
  detectorProblem: string | null;
};

/**
 * The steps for one job. Resolves both gates, and probes the detector Python only when both gates
 * turned a detector step on: a job that runs no detector step starts no Python. When the probe
 * fails, the detector steps resolve as off with the reason `no-detector` and the problem comes
 * back for the job's one selection_steps_unavailable event, so a missing or broken runtime is one
 * alert and not one failed clip at a time. The cause goes to the worker log here, because the
 * job's event belongs to the workspace and must not carry a server path.
 */
export async function resolveJobSelectionSteps(
  input: { environment: SelectionStepsEnvironment; workspaceSettings: unknown; configuredPython: string | undefined },
  probe: DetectorProbe = defaultDetectorProbe,
): Promise<JobSelectionSteps> {
  const workspace = parseSelectionStepsSettings(input.workspaceSettings);
  const detectorSteps = DETECTOR_STEPS.filter((step) => gatesAgree(step, input.environment, workspace));
  let detectorPython: string | undefined;
  let detectorProblem: string | null = null;
  if (detectorSteps.length > 0) {
    const configured = input.configuredPython || undefined;
    if (!configured) {
      detectorProblem = "DETECTOR_PYTHON is not set";
    } else {
      const problem = await probe(configured);
      if (problem === null) detectorPython = configured;
      else detectorProblem = problem;
    }
  }
  if (detectorProblem !== null) {
    console.error(`[worker] selection steps: ${detectorSteps.join(" and ")} count as off because ${detectorProblem}.`);
  }
  return {
    steps: resolveSelectionSteps({
      environment: input.environment,
      workspaceSettings: input.workspaceSettings,
      detectorPython,
    }),
    detectorSteps,
    detectorPython,
    detectorProblem,
  };
}

const STEP_LABELS: Record<SelectionStep, string> = {
  sermonSpan: "The sermon span",
  boundaryStep: "The boundary step",
  dropoutCheck: "The dropout check",
  cameraCheck: "The camera check",
  agreementRanking: "Agreement ranking",
  phraseCaptions: "Phrase captions",
  speakerTracking: "Speaker tracking",
};

/**
 * The one selection_steps_unavailable event a job records when a detector step both gates turned
 * on cannot run. Category `worker`, like the boot check's event, so one missing runtime is one
 * alert per throttle window and not one per job type. No cause and no path: the event belongs to
 * the workspace, the church's operations page shows it, and the worker log has the detail.
 */
export function selectionStepUnavailableEvent(input: {
  step: SelectionStep;
  consequence: string;
  steps: ResolvedSelectionSteps;
}) {
  return {
    category: "worker" as const,
    eventType: "selection_steps_unavailable",
    severity: "error" as const,
    message: `${STEP_LABELS[input.step]} is on for this workspace, but the worker cannot run the detector, so ${input.consequence}.`,
    metadata: { step: input.step, steps: input.steps },
  };
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
 * absent (`missing`) or the probe fails (`broken`: no scripts, no such path, no OpenCV), the
 * worker records one selection_steps_unavailable event with severity error and the cause, so a
 * missing runtime is one alert at boot instead of a surprise on the first sermon. The boot event
 * has no workspace, so it never reaches a church's operations page and may name the path.
 */
export async function checkDetectorRuntime(
  input: { environment: SelectionStepsEnvironment; detectorPython: string | undefined },
  probe: DetectorProbe = defaultDetectorProbe,
): Promise<DetectorRuntimeCheck> {
  const steps = DETECTOR_STEPS.filter((step) => input.environment[SELECTION_STEP_VARIABLES[step]] === true);
  const detectorPython = input.detectorPython || null;
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
  const problem = await probe(detectorPython);
  if (problem !== null) {
    return {
      status: "broken",
      steps,
      detectorPython,
      message: `The detector cannot run: ${problem}. ${named} count as off until it does.`,
    };
  }
  return {
    status: "ok",
    steps,
    detectorPython,
    message: `The detector Python at ${detectorPython} runs: the scripts are present and it imports OpenCV.`,
  };
}
