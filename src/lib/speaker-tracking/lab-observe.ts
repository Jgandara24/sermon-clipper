import { readFile } from "node:fs/promises";
import path from "node:path";
import { detectorScriptPath } from "@/lib/analysis/selection-steps";
import { envTimeoutMs, execFileWithTimeout } from "@/lib/media/child-process";
import { buildLabTrack, type LabTrack, type ObservationFile } from "./lab-track";

const OBSERVE_SCRIPT = detectorScriptPath("observeFaces");

/**
 * Speaker tracking: runs the YuNet face observer over one clip range of a local source file, then
 * builds the lab-v1 speaker track. The render seeks to `range.startMs`, so command times count from
 * there. `python` is the detector Python (DETECTOR_PYTHON), resolved by the caller once per job.
 */
export async function computeLabSpeakerTrack(params: {
  python: string;
  sourceFilePath: string;
  range: { startMs: number; endMs: number };
  workDir: string;
}): Promise<LabTrack> {
  const out = path.join(params.workDir, "speaker-observations.json");
  const seekSeconds = Number((params.range.startMs / 1000).toFixed(3));
  await execFileWithTimeout(
    params.python,
    [
      OBSERVE_SCRIPT,
      "--source", params.sourceFilePath,
      "--start", String(seekSeconds),
      "--end", String(params.range.endMs / 1000),
      "--out", out,
    ],
    { maxBuffer: 1024 * 1024 * 8, timeoutMs: envTimeoutMs("LAB_TRACKING_TIMEOUT_MS", 15 * 60_000) },
  );
  const file = JSON.parse(await readFile(out, "utf8")) as ObservationFile;
  return buildLabTrack(file, { seekSeconds, rules: "lab-v1" });
}
