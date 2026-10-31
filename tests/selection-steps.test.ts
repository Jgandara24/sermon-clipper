import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySelectionStepsChange,
  availableDetectorPython,
  checkDetectorRuntime,
  parseSelectionStepsSettings,
  resolveSelectionSteps,
  SELECTION_STEP_VARIABLES,
  SELECTION_STEPS,
  selectionStepsOn,
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

describe("availableDetectorPython", () => {
  it("is undefined when DETECTOR_PYTHON is absent, without running anything", () => {
    const probe = vi.fn(() => true);
    expect(availableDetectorPython(undefined, probe)).toBeUndefined();
    expect(availableDetectorPython("", probe)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("is the path when that Python imports OpenCV", () => {
    const probe = vi.fn((python: string) => python === PYTHON);
    expect(availableDetectorPython(PYTHON, probe)).toBe(PYTHON);
    expect(probe).toHaveBeenCalledWith(PYTHON);
  });

  it("is undefined when that Python cannot import OpenCV, so the detector steps count as off", () => {
    const probe = vi.fn(() => false);
    expect(availableDetectorPython(PYTHON, probe)).toBeUndefined();
    const steps = resolveSelectionSteps({
      environment: EVERY_VARIABLE_ON,
      workspaceSettings: EVERY_STEP_ON,
      detectorPython: availableDetectorPython(PYTHON, probe),
    });
    expect(steps.cameraCheck).toEqual({ on: false, reason: "no-detector" });
    expect(steps.speakerTracking).toEqual({ on: false, reason: "no-detector" });
  });
});

describe("checkDetectorRuntime", () => {
  it("has nothing to check when no detector step is on in the environment, even without a Python", () => {
    const probe = vi.fn(() => true);
    const check = checkDetectorRuntime(
      { environment: { ANALYSIS_BOUNDARY_STEP_ENABLED: true }, detectorPython: undefined },
      probe,
    );
    expect(check.status).toBe("not-needed");
    expect(check.steps).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports a missing Python when a detector step is on and DETECTOR_PYTHON is absent", () => {
    const check = checkDetectorRuntime(
      { environment: { ANALYSIS_CAMERA_CHECK_ENABLED: true }, detectorPython: undefined },
      () => true,
    );
    expect(check.status).toBe("missing");
    expect(check.steps).toEqual(["cameraCheck"]);
    expect(check.detectorPython).toBeNull();
    expect(check.message).toContain("DETECTOR_PYTHON is not set");
    expect(check.message).toContain("cameraCheck");
  });

  it("reports a broken Python when it cannot import OpenCV", () => {
    const check = checkDetectorRuntime(
      {
        environment: { ANALYSIS_CAMERA_CHECK_ENABLED: true, EXPORT_SPEAKER_TRACKING_ENABLED: true },
        detectorPython: PYTHON,
      },
      () => false,
    );
    expect(check.status).toBe("broken");
    expect(check.steps).toEqual(["cameraCheck", "speakerTracking"]);
    expect(check.message).toContain(PYTHON);
    expect(check.message).toContain("cameraCheck and speakerTracking");
  });

  it("reports ok when the Python imports OpenCV", () => {
    const check = checkDetectorRuntime(
      { environment: { EXPORT_SPEAKER_TRACKING_ENABLED: true }, detectorPython: PYTHON },
      (python) => python === PYTHON,
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
