import { describe, expect, it } from "vitest";
import {
  END_SNAP_FRAME_MS,
  END_SNAP_LOUD_DB,
  END_SNAP_SILENT_DB,
  parseRmsFrames,
  snapEndIntoSilence,
  type RmsFrame,
} from "@/lib/analysis/end-silence";

/** Consecutive 20 ms frames from `startMs`: each entry is [how long, level in dB]. */
function frames(startMs: number, spec: [number, number][]): RmsFrame[] {
  const out: RmsFrame[] = [];
  let at = startMs;
  for (const [ms, db] of spec) {
    for (let t = 0; t < ms; t += END_SNAP_FRAME_MS) {
      out.push({ startMs: at, endMs: at + END_SNAP_FRAME_MS, db });
      at += END_SNAP_FRAME_MS;
    }
  }
  return out;
}

describe("parseRmsFrames", () => {
  it("pairs each pts_time with the RMS level that follows it, on the source clock", () => {
    const log =
      "frame:0    pts:0       pts_time:0\nlavfi.astats.Overall.RMS_level=-66.230000\n" +
      "frame:1    pts:960     pts_time:0.02\nlavfi.astats.Overall.RMS_level=-inf\n" +
      "frame:2    pts:1920    pts_time:0.04\nlavfi.astats.Overall.RMS_level=-35.5\n";
    expect(parseRmsFrames(log, 3031300)).toEqual([
      { startMs: 3031300, endMs: 3031320, db: -66.23 },
      { startMs: 3031320, endMs: 3031340, db: -99 },
      { startMs: 3031340, endMs: 3031360, db: -35.5 },
    ]);
  });
});

describe("fix V: snapEndIntoSilence", () => {
  // Lab sermon 4h clip 5: "heaven." ends at 50:31.50, silence to 50:33.72, "In" starts at 50:33.74,
  // the cut at 50:33.858 (the transcript's two phantom "Amen." words) sits 100 ms into "In".
  const FOUR_H_C5 = frames(3031300, [
    [200, -62], // the tail of "heaven."
    [2220, -80], // the pause
    [300, -32], // "In the Book of Luke"
  ]);

  it("moves lab sermon 4h clip 5's cut back into the pause, 40 ms before the sound starts", () => {
    expect(snapEndIntoSilence(FOUR_H_C5, 3033858)).toEqual({ endMs: 3033680, movedMs: -178 });
  });

  it("keeps a cut that already falls in the pause", () => {
    expect(snapEndIntoSilence(FOUR_H_C5, 3033000)).toBeNull();
  });

  it("keeps a cut inside continuous speech", () => {
    const speech = frames(1_000_000, [[2000, -30]]);
    expect(snapEndIntoSilence(speech, 1_001_500)).toBeNull();
  });

  it("does not take a short dip inside a word for a pause", () => {
    // A stop consonant: 100 ms near-silence inside speech, then the word goes on.
    const word = frames(1_000_000, [
      [1000, -30],
      [100, -60],
      [100, -30],
    ]);
    expect(snapEndIntoSilence(word, 1_001_200)).toBeNull();
  });

  it("moves back only within 400 ms of the cut", () => {
    const farPause = frames(1_000_000, [
      [1000, -80],
      [500, -30],
    ]);
    expect(snapEndIntoSilence(farPause, 1_001_500)).toBeNull();
    const nearPause = frames(1_000_000, [
      [1000, -80],
      [100, -30],
    ]);
    expect(snapEndIntoSilence(nearPause, 1_001_100)).toEqual({ endMs: 1_000_960, movedMs: -140 });
  });

  it("needs sound at the cut and a pause of 200 ms or more", () => {
    const quietCut = frames(1_000_000, [
      [1000, -80],
      [100, END_SNAP_LOUD_DB - 1],
    ]);
    expect(snapEndIntoSilence(quietCut, 1_001_100)).toBeNull();
    const shortPause = frames(1_000_000, [
      [1000, -30],
      [180, END_SNAP_SILENT_DB],
      [100, -30],
    ]);
    expect(snapEndIntoSilence(shortPause, 1_001_280)).toBeNull();
  });

  it("returns null when there are no frames", () => {
    expect(snapEndIntoSilence([], 1000)).toBeNull();
  });
});
