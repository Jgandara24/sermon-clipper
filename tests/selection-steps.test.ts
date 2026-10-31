import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  applySelectionStepsChange,
  checkDetectorRuntime,
  DETECTOR_SCRIPTS,
  defaultDetectorProbe,
  detectorScriptPath,
  parseSelectionStepsSettings,
  resolveJobSelectionSteps,
  resolveSelectionSteps,
  SELECTION_STEP_VARIABLES,
  SELECTION_STEPS,
  selectionStepsOn,
  selectionStepUnavailableEvent,
  type SelectionStep,
  type SelectionStepsEnvironment,
} from "@/lib/analysis/selection-steps";

const PYTHON = "/opt/detector/bin/python";

const EVERY_VARIABLE_ON: SelectionStepsEnvironment = {
  ANALYSIS_SERMON_SPAN_ENABLED: true,
  ANALYSIS_BOUNDARY_STEP_ENABLED: true,
  ANALYSIS_DROPOUT_CHECK_ENABLED: true,
  ANALYSIS_CAMERA_CHECK_ENABLED: true,
  ANALYSIS_AGREEMENT_RANKING_ENABLED: true,
  EXPORT_PHRASE_CAPTIONS_ENABLED: true,
  EXPORT_SPEAKER_TRACKING_ENABLED: true,
};

function workspaceWith(steps: Partial<Record<SelectionStep, unknown>>) {
  return { churchProfile: { timezone: "UTC" }, selectionSteps: steps };
}

const EVERY_STEP_ON = workspaceWith(Object.fromEntries(SELECTION_STEPS.map((step) => [step, true])));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveSelectionSteps", () => {
  it("turns every step off when nothing is set, and names the environment as the reason", () => {
    const steps = resolveSelectionSteps({ environment: {}, workspaceSettings: null, detectorPython: undefined });
    for (const step of SELECTION_STEPS) {
      expect(steps[step]).toEqual({ on: false, reason: "environment" });
    }
    expect(selectionStepsOn(steps)).toEqual([]);
  });

  it("keeps a step off when only the environment gate is on, and names the workspace", () => {
    const steps = resolveSelectionSteps({
      environment: EVERY_VARIABLE_ON,
      workspaceSettings: workspaceWith({}),
      detectorPython: PYTHON,
    });
    for (const step of SELECTION_STEPS) {
      expect(steps[step]).toEqual({ on: false, reason: "workspace" });
    }
  });

  it("keeps a step off when only the workspace gate is on, and names the environment", () => {
    const steps = resolveSelectionSteps({
      environment: {},
      workspaceSettings: EVERY_STEP_ON,
      detectorPython: PYTHON,
    });
    for (const step of SELECTION_STEPS) {
      expect(steps[step]).toEqual({ on: false, reason: "environment" });
    }
  });

  it("turns a step on only when both gates agree, one step at a time", () => {
    const steps = resolveSelectionSteps({
      environment: { ANALYSIS_BOUNDARY_STEP_ENABLED: true, ANALYSIS_SERMON_SPAN_ENABLED: true },
      workspaceSettings: workspaceWith({ boundaryStep: true, dropoutCheck: true }),
      detectorPython: undefined,
    });
    expect(steps.boundaryStep).toEqual({ on: true, reason: null });
    expect(steps.sermonSpan).toEqual({ on: false, reason: "workspace" });
    expect(steps.dropoutCheck).toEqual({ on: false, reason: "environment" });
    expect(selectionStepsOn(steps)).toEqual(["boundaryStep"]);
  });

  it("turns the detector steps off without the detector Python and leaves the others on", () => {
    const steps = resolveSelectionSteps({
      environment: EVERY_VARIABLE_ON,
      workspaceSettings: EVERY_STEP_ON,
      detectorPython: undefined,
    });
    expect(steps.cameraCheck).toEqual({ on: false, reason: "no-detector" });
    expect(steps.speakerTracking).toEqual({ on: false, reason: "no-detector" });
    expect(selectionStepsOn(steps)).toEqual([
      "sermonSpan",
      "boundaryStep",
      "dropoutCheck",
      "agreementRanking",
      "phraseCaptions",
    ]);
  });

  it("turns every step on when both gates agree and the detector Python is present", () => {
    const steps = resolveSelectionSteps({
      environment: EVERY_VARIABLE_ON,
      workspaceSettings: EVERY_STEP_ON,
      detectorPython: PYTHON,
    });
    expect(selectionStepsOn(steps)).toEqual([...SELECTION_STEPS]);
  });

  // The environment gate wins the reason: an operator who sees `environment` knows the worker's
  // variables come first, whatever the workspace says.
  it("names the environment when both gates are off", () => {
    const steps = resolveSelectionSteps({ environment: {}, workspaceSettings: workspaceWith({}), detectorPython: undefined });
    expect(steps.cameraCheck).toEqual({ on: false, reason: "environment" });
  });

  it("never reads NODE_ENV: production resolves the same way as the lab", () => {
    vi.stubEnv("NODE_ENV", "production");
    const steps = resolveSelectionSteps({
      environment: EVERY_VARIABLE_ON,
      workspaceSettings: EVERY_STEP_ON,
      detectorPython: PYTHON,
    });
    expect(steps.boundaryStep).toEqual({ on: true, reason: null });
  });
});

describe("parseSelectionStepsSettings", () => {
  it("reads a workspace that was never configured as every step off", () => {
    for (const settings of [null, undefined, {}, [], "on", { churchProfile: {} }]) {
      const parsed = parseSelectionStepsSettings(settings);
      for (const step of SELECTION_STEPS) expect(parsed[step]).toBe(false);
    }
  });

  it("reads a selectionSteps key that is not an object as every step off", () => {
    for (const section of ["on", true, 1, ["boundaryStep"], null]) {
      const parsed = parseSelectionStepsSettings({ selectionSteps: section });
      for (const step of SELECTION_STEPS) expect(parsed[step]).toBe(false);
    }
  });

  // A step changes what a church sees, so anything that is not exactly the boolean true is off.
  it.each([["true"], [1], ["yes"], [{}], [null], ["on"]])("reads %o as off", (value) => {
    const parsed = parseSelectionStepsSettings(workspaceWith({ boundaryStep: value }));
    expect(parsed.boundaryStep).toBe(false);
  });

  it("ignores unknown keys and reads each named step on its own", () => {
    const parsed = parseSelectionStepsSettings(
      workspaceWith({ boundaryStep: true, phraseCaptions: false, labelMaker: true } as Record<string, unknown>),
    );
    expect(parsed).toEqual({
      sermonSpan: false,
      boundaryStep: true,
      dropoutCheck: false,
      cameraCheck: false,
      agreementRanking: false,
      phraseCaptions: false,
      speakerTracking: false,
    });
  });
});

describe("applySelectionStepsChange", () => {
  it("creates the selectionSteps key for a workspace that has none, leaving other sections alone", () => {
    const next = applySelectionStepsChange(
      { churchProfile: { postsPerDay: 2 } },
      { on: ["sermonSpan", "boundaryStep"], off: [] },
    );
    expect(next).toEqual({
      churchProfile: { postsPerDay: 2 },
      selectionSteps: { sermonSpan: true, boundaryStep: true },
    });
  });

  it("turns steps on and off in place and keeps the keys it was not asked about", () => {
    const next = applySelectionStepsChange(
      { selectionSteps: { sermonSpan: true, cameraCheck: true, labelMaker: "keep" } },
      { on: ["phraseCaptions"], off: ["cameraCheck"] },
    );
    expect(next.selectionSteps).toEqual({
      sermonSpan: true,
      cameraCheck: false,
      labelMaker: "keep",
      phraseCaptions: true,
    });
    expect(parseSelectionStepsSettings(next).cameraCheck).toBe(false);
    expect(parseSelectionStepsSettings(next).phraseCaptions).toBe(true);
  });

  it("does not change the settings object it was given", () => {
    const current = { selectionSteps: { sermonSpan: true } };
    applySelectionStepsChange(current, { on: [], off: ["sermonSpan"] });
    expect(current.selectionSteps.sermonSpan).toBe(true);
  });
});

describe("resolveJobSelectionSteps", () => {
  it("starts no Python when no detector step passed both gates, even with DETECTOR_PYTHON set", async () => {
    const probe = vi.fn(async () => null);
    const job = await resolveJobSelectionSteps(
      {
        environment: EVERY_VARIABLE_ON,
        workspaceSettings: workspaceWith({ sermonSpan: true, boundaryStep: true }),
        configuredPython: PYTHON,
      },
      probe,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(job.detectorSteps).toEqual([]);
    expect(job.detectorPython).toBeUndefined();
    expect(job.detectorProblem).toBeNull();
    expect(job.steps.sermonSpan).toEqual({ on: true, reason: null });
    expect(job.steps.cameraCheck).toEqual({ on: false, reason: "workspace" });
  });

  it("probes once and hands the detector steps the path when it runs", async () => {
    const probe = vi.fn(async () => null);
    const job = await resolveJobSelectionSteps(
      { environment: EVERY_VARIABLE_ON, workspaceSettings: EVERY_STEP_ON, configuredPython: PYTHON },
      probe,
    );
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(PYTHON);
    expect(job.detectorSteps).toEqual(["cameraCheck", "speakerTracking"]);
    expect(job.detectorPython).toBe(PYTHON);
    expect(job.detectorProblem).toBeNull();
    expect(selectionStepsOn(job.steps)).toEqual([...SELECTION_STEPS]);
  });

  it("names a missing DETECTOR_PYTHON as the problem: the detector steps go off, the others stay on", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const probe = vi.fn(async () => null);
    const job = await resolveJobSelectionSteps(
      { environment: EVERY_VARIABLE_ON, workspaceSettings: EVERY_STEP_ON, configuredPython: undefined },
      probe,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(job.detectorProblem).toBe("DETECTOR_PYTHON is not set");
    expect(job.detectorPython).toBeUndefined();
    expect(job.steps.cameraCheck).toEqual({ on: false, reason: "no-detector" });
    expect(job.steps.speakerTracking).toEqual({ on: false, reason: "no-detector" });
    expect(job.steps.sermonSpan).toEqual({ on: true, reason: null });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("DETECTOR_PYTHON is not set"));
  });

  it("treats an empty DETECTOR_PYTHON as unset", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const probe = vi.fn(async () => null);
    const job = await resolveJobSelectionSteps(
      { environment: EVERY_VARIABLE_ON, workspaceSettings: EVERY_STEP_ON, configuredPython: "" },
      probe,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(job.detectorProblem).toBe("DETECTOR_PYTHON is not set");
  });

  it("treats a Python the probe rejects as off, with the probe's cause, so a broken runtime is one alert", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = `${PYTHON} cannot import OpenCV (ModuleNotFoundError: No module named 'cv2')`;
    const job = await resolveJobSelectionSteps(
      { environment: EVERY_VARIABLE_ON, workspaceSettings: EVERY_STEP_ON, configuredPython: PYTHON },
      async () => cause,
    );
    expect(job.detectorProblem).toBe(cause);
    expect(job.detectorPython).toBeUndefined();
    expect(job.steps.cameraCheck).toEqual({ on: false, reason: "no-detector" });
    expect(job.steps.speakerTracking).toEqual({ on: false, reason: "no-detector" });
    expect(job.steps.agreementRanking).toEqual({ on: true, reason: null });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(cause));
  });
});

describe("selectionStepUnavailableEvent", () => {
  it("is an error under the worker category, names the step and the consequence, and carries no path", () => {
    const steps = resolveSelectionSteps({
      environment: EVERY_VARIABLE_ON,
      workspaceSettings: EVERY_STEP_ON,
      detectorPython: undefined,
    });
    const event = selectionStepUnavailableEvent({ step: "cameraCheck", consequence: "ANALYZE ran without it", steps });
    expect(event).toMatchObject({ category: "worker", eventType: "selection_steps_unavailable", severity: "error" });
    expect(event.message).toBe(
      "The camera check is on for this workspace, but the worker cannot run the detector, so ANALYZE ran without it.",
    );
    expect(event.metadata).toEqual({ step: "cameraCheck", steps });
  });
});

describe("detectorScriptPath", () => {
  it("resolves the three scripts under the working directory, which the worker image must carry", () => {
    expect(detectorScriptPath("cameraSample", "/app")).toBe("/app/scripts/lab/tracking/camera-sample.py");
    expect(detectorScriptPath("observePeople", "/app")).toBe("/app/scripts/lab/tracking/observe-people.py");
    expect(detectorScriptPath("observeFaces", "/app")).toBe("/app/scripts/lab/tracking/observe-faces.py");
    for (const script of Object.values(DETECTOR_SCRIPTS)) expect(existsSync(path.resolve(script))).toBe(true);
  });
});

describe("defaultDetectorProbe", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "detector-probe-"));
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("names a missing detector script before it starts any Python", async () => {
    const problem = await defaultDetectorProbe(path.join(tmp, "no-such-python"), tmp);
    expect(problem).toBe(`the detector script ${path.join(tmp, "scripts/lab/tracking/camera-sample.py")} is missing`);
  });

  it("names a Python that does not start", async () => {
    const python = path.join(tmp, "no-such-python");
    await expect(defaultDetectorProbe(python)).resolves.toBe(`${python} did not start (ENOENT)`);
  });

  it("names a Python that cannot import OpenCV, with the interpreter's last line", async () => {
    // node has no cv2 either: `node -c "import cv2"` exits non-zero with a message on stderr.
    const problem = await defaultDetectorProbe(process.execPath);
    expect(problem).toContain(`${process.execPath} cannot import OpenCV (`);
  });

  it("is null when the scripts are present and the import succeeds", async () => {
    const python = path.join(tmp, "python");
    writeFileSync(python, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await expect(defaultDetectorProbe(python)).resolves.toBeNull();
  });
});

describe("checkDetectorRuntime", () => {
  it("has nothing to check when no detector step is on in the environment, even without a Python", async () => {
    const probe = vi.fn(async () => null);
    const check = await checkDetectorRuntime(
      { environment: { ANALYSIS_BOUNDARY_STEP_ENABLED: true }, detectorPython: undefined },
      probe,
    );
    expect(check.status).toBe("not-needed");
    expect(check.steps).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports a missing Python when a detector step is on and DETECTOR_PYTHON is absent", async () => {
    const check = await checkDetectorRuntime(
      { environment: { ANALYSIS_CAMERA_CHECK_ENABLED: true }, detectorPython: undefined },
      async () => null,
    );
    expect(check.status).toBe("missing");
    expect(check.steps).toEqual(["cameraCheck"]);
    expect(check.detectorPython).toBeNull();
    expect(check.message).toContain("DETECTOR_PYTHON is not set");
    expect(check.message).toContain("cameraCheck");
  });

  it("reports a broken runtime with the probe's cause", async () => {
    const check = await checkDetectorRuntime(
      {
        environment: { ANALYSIS_CAMERA_CHECK_ENABLED: true, EXPORT_SPEAKER_TRACKING_ENABLED: true },
        detectorPython: PYTHON,
      },
      async () => "the detector script /app/scripts/lab/tracking/camera-sample.py is missing",
    );
    expect(check.status).toBe("broken");
    expect(check.steps).toEqual(["cameraCheck", "speakerTracking"]);
    expect(check.detectorPython).toBe(PYTHON);
    expect(check.message).toContain("camera-sample.py is missing");
    expect(check.message).toContain("cameraCheck and speakerTracking");
  });

  it("reports ok when the probe passes", async () => {
    const check = await checkDetectorRuntime(
      { environment: { EXPORT_SPEAKER_TRACKING_ENABLED: true }, detectorPython: PYTHON },
      async (python) => (python === PYTHON ? null : "wrong path"),
    );
    expect(check.status).toBe("ok");
    expect(check.detectorPython).toBe(PYTHON);
  });
});

describe("the environment gate's names", () => {
  // docs/SELECTION_STEPS_SETTINGS_PLAN.md, section 2.1. They describe the step, not the lab.
  it("are the seven variables the plan names, one per step", () => {
    expect(SELECTION_STEP_VARIABLES).toEqual({
      sermonSpan: "ANALYSIS_SERMON_SPAN_ENABLED",
      boundaryStep: "ANALYSIS_BOUNDARY_STEP_ENABLED",
      dropoutCheck: "ANALYSIS_DROPOUT_CHECK_ENABLED",
      cameraCheck: "ANALYSIS_CAMERA_CHECK_ENABLED",
      agreementRanking: "ANALYSIS_AGREEMENT_RANKING_ENABLED",
      phraseCaptions: "EXPORT_PHRASE_CAPTIONS_ENABLED",
      speakerTracking: "EXPORT_SPEAKER_TRACKING_ENABLED",
    });
  });
});
