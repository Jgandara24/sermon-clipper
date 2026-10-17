import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileWithTimeout } from "@/lib/media/child-process";
import { discoverSourceKeyframes } from "@/lib/media/keyframes";
import { fileIdentity } from "@/lib/storage/file-identity";
import { planCandidateRanges } from "@/lib/media/candidate-ranges";
let root: string;
const settings = { timeoutMs: 30000, maxOutputBytes: 1024 * 1024, maxPackets: 1000 };
async function fixture(name: string, rate = "10", offset = "0") {
  const file = path.join(root, name + ".mp4");
  await execFileWithTimeout("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
    `testsrc2=s=96x64:r=${rate}:d=3`, "-c:v", "libx264", "-threads", "1", "-g", "10", "-keyint_min", "10",
    "-sc_threshold", "0", "-output_ts_offset", offset, file], { timeoutMs: 30000 });
  return { path: file, ...await fileIdentity(file), sourceDurationMs: 3000, sourceOriginMs: 0 };
}
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), "p4-keyframes-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
describe("source keyframes", () => {
  it("discovers source keyframes and drives candidate padding", async () => {
    const input = await fixture("normal");
    const result = await discoverSourceKeyframes(input, settings);
    expect(result.keyframeTimesMs).toEqual([0, 1000, 2000]);
    expect(result.stream).toMatchObject({ width: 96, height: 64, codec_name: "h264" });
    expect(result.packetCount).toBe(30);
    const plan = planCandidateRanges({ sourceSha256: input.sha256, sourceDurationMs: 3000,
      candidates: [{ candidateId: "one", sourceInterval: { startMs: 1100, endMs: 1700 } }],
      handles: { beforeMs: 50, afterMs: 50 }, keyframeTimesMs: result.keyframeTimesMs });
    expect(plan.ranges[0].sourceInterval).toEqual({ startMs: 1000, endMs: 2000 });
    expect((await discoverSourceKeyframes(input, { ...settings, maxPackets: 2000 })).evidenceSha256).toBe(result.evidenceSha256);
  });
  it("normalizes an explicit nonzero source origin", async () => {
    const input = await fixture("shifted", "10", "5");
    expect((await discoverSourceKeyframes({ ...input, sourceOriginMs: 5000 }, settings)).keyframeTimesMs).toEqual([0, 1000, 2000]);
    await expect(discoverSourceKeyframes(input, settings)).rejects.toThrow("OUTSIDE_SOURCE");
  });
  it("preserves fractional millisecond keyframes through candidate planning", async () => {
    const input = await fixture("fractional", "30000/1001");
    const result = await discoverSourceKeyframes(input, settings);
    expect(result.keyframeTimesMs.slice(0, 4)).toEqual([0,
      { numerator: "1001", denominator: "3" }, { numerator: "2002", denominator: "3" }, 1001]);
    const plan = planCandidateRanges({ sourceSha256: input.sha256, sourceDurationMs: 3000,
      candidates: [{ candidateId: "fraction", sourceInterval: { startMs: 334, endMs: 667 } }],
      handles: { beforeMs: 0, afterMs: 0 }, keyframeTimesMs: result.keyframeTimesMs });
    expect(plan.ranges[0].sourceInterval).toEqual({ startMs: { numerator: "1001", denominator: "3" },
      endMs: { numerator: "2002", denominator: "3" } });
    expect(plan.coverage[0].plannedRelativeInterval).toEqual({ startMs: { numerator: "1", denominator: "3" },
      endMs: { numerator: "1000", denominator: "3" } });
  });
  it("refuses mismatched inputs and bounded scan failures", async () => {
    const input = await fixture("limits");
    await expect(discoverSourceKeyframes({ ...input, sha256: "0".repeat(64) }, settings)).rejects.toThrow("INPUT_CHANGED");
    await expect(discoverSourceKeyframes(input, { ...settings, maxPackets: 1 })).rejects.toThrow("PACKET_LIMIT_EXCEEDED");
    await expect(discoverSourceKeyframes(input, { ...settings, maxOutputBytes: 100 })).rejects.toThrow();
  });
});
