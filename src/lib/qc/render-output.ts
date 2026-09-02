/**
 * P1.3: a rendered export must prove it is usable before anything keeps it.
 *
 * The old path uploaded first and probed afterwards with `.catch(() => null)`, then wrote the
 * 1080x1920 constants into `ExportedFile` when the probe had failed. A file that did not decode,
 * carried no audio, or came out the wrong shape was stored, recorded with invented dimensions,
 * and marked SUCCEEDED. `SUCCEEDED` now means the file passed these checks.
 *
 * This module is pure. It takes facts that were measured elsewhere and returns a verdict plus the
 * record of every check it ran, so the stored `qcDetails` says what was true rather than only
 * what was wrong.
 */

/** Stable failure code for an export whose output did not pass QC. */
export const RENDER_QC_FAILED = "RENDER_QC_FAILED";

export const RENDER_QC_FAILED_MESSAGE =
  "This export didn't come out right, so we didn't save it. Try exporting it again.";

export type RenderQcProbeFacts = {
  durationS: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
};

export type RenderQcFacts = {
  /** Null when ffprobe could not read the file. `probeError` then says why. */
  probe: RenderQcProbeFacts | null;
  /** The reason ffprobe gave, kept rather than swallowed. */
  probeError: string | null;
  bytes: number;
  checksum: string;
  /** Caption events the burn-in actually emitted for this render. */
  captionEvents: number;
};

export type RenderQcExpectation = {
  width: number;
  height: number;
  durationS: number;
  durationToleranceS: number;
  /** Caption lines the render was given. Zero means this clip has no captions to burn. */
  captionLines: number;
};

export type RenderQcCheckName =
  | "decodes"
  | "dimensions"
  | "hasAudio"
  | "duration"
  | "bytes"
  | "checksum"
  | "captionEvents";

export type RenderQcCheck = {
  name: RenderQcCheckName;
  passed: boolean;
  /** Human-readable, and safe to store: it carries measurements, never file paths or keys. */
  detail: string;
};

export type RenderQcResult = {
  status: "PASSED" | "FAILED";
  checks: RenderQcCheck[];
  failures: RenderQcCheck[];
};

/**
 * How far a rendered duration may sit from the duration the edit asked for.
 *
 * A re-encode moves the duration by well under a second, but a keyframe-aligned seek can move it
 * further on a long clip. A flat tolerance would either fail short clips on normal drift or let a
 * badly truncated long clip through, so it scales: five percent of the expected duration, never
 * below one second. A truncation worth catching is far larger than either bound.
 */
export function renderQcDurationToleranceS(expectedDurationS: number): number {
  return Math.max(1, expectedDurationS * 0.05);
}

export function evaluateRenderOutputQc(
  facts: RenderQcFacts,
  expectation: RenderQcExpectation,
): RenderQcResult {
  const checks: RenderQcCheck[] = [];
  const { probe } = facts;

  checks.push({
    name: "decodes",
    passed: probe !== null,
    detail: probe
      ? "ffprobe read the file and found a video stream."
      : `ffprobe could not read the file: ${facts.probeError ?? "no reason reported"}`,
  });

  // Every remaining stream fact comes from the probe. Reporting "no audio" or "wrong dimensions"
  // for a file that never decoded would send the reader after the wrong defect, so these checks
  // are skipped rather than failed.
  if (probe) {
    const dimensionsMatch =
      probe.width === expectation.width && probe.height === expectation.height;
    checks.push({
      name: "dimensions",
      passed: dimensionsMatch,
      detail: dimensionsMatch
        ? `${probe.width}x${probe.height}, as expected.`
        : `expected ${expectation.width}x${expectation.height}, got ${probe.width ?? "unknown"}x${probe.height ?? "unknown"}.`,
    });

    checks.push({
      name: "hasAudio",
      passed: probe.hasAudio,
      detail: probe.hasAudio ? "an audio stream is present." : "no audio stream is present.",
    });

    const drift = Math.abs(probe.durationS - expectation.durationS);
    const durationMatches = drift <= expectation.durationToleranceS;
    checks.push({
      name: "duration",
      passed: durationMatches,
      detail: durationMatches
        ? `${probe.durationS.toFixed(3)}s, within ${expectation.durationToleranceS.toFixed(3)}s of the expected ${expectation.durationS.toFixed(3)}s.`
        : `expected ${expectation.durationS.toFixed(3)}s within ${expectation.durationToleranceS.toFixed(3)}s, got ${probe.durationS.toFixed(3)}s (off by ${drift.toFixed(3)}s).`,
    });
  }

  checks.push({
    name: "bytes",
    passed: facts.bytes > 0,
    detail: facts.bytes > 0 ? `${facts.bytes} bytes.` : "the file is empty.",
  });

  const hasChecksum = facts.checksum.trim().length > 0;
  checks.push({
    name: "checksum",
    passed: hasChecksum,
    detail: hasChecksum ? "a checksum was computed." : "no checksum was computed.",
  });

  // A clip with caption lines whose burn-in drew nothing is the blank-caption render: the file is
  // otherwise healthy, so no other check here would notice it. A clip with no caption lines has
  // nothing to draw, and this check does not apply to it.
  const captionEventsExpected = expectation.captionLines > 0;
  const captionEventsPresent = facts.captionEvents > 0;
  checks.push({
    name: "captionEvents",
    passed: !captionEventsExpected || captionEventsPresent,
    detail: captionEventsExpected
      ? `${expectation.captionLines} caption lines produced ${facts.captionEvents} caption events.`
      : "this clip has no caption lines to burn in.",
  });

  const failures = checks.filter((check) => !check.passed);
  return {
    status: failures.length === 0 ? "PASSED" : "FAILED",
    checks,
    failures,
  };
}
