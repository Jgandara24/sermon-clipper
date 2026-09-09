import { describe, expect, it } from "vitest";
import { compareSyntheticAudio, inspectSyntheticAudio } from "@/lib/evaluation/synthetic-audio-timing";

function fixture(startMs = 2000, endMs = 2200, rate = 16000) {
  const total = rate * 4;
  const pcm = Buffer.alloc(total * 4);
  for (let i = startMs * rate / 1000; i < endMs * rate / 1000; i++) pcm.writeFloatLE(0.3, i * 4);
  const frames = [];
  for (let first = 0; first < total; first += 1024) frames.push({
    best_effort_timestamp_time: (first / rate).toFixed(6), nb_samples: Math.min(1024, total - first) });
  return { pcm, probe: { format: { start_time: "0.000000", duration: "4.000000" },
    streams: [{ codec_name: "flac", start_time: "0.000000", sample_rate: String(rate), channels: 1 }], frames } };
}
const source = () => { const { probe, pcm } = fixture(); return inspectSyntheticAudio(probe, pcm); };
const mapping = { sourceStartMs: 1000, sourceEndMs: 3000 };

describe("synthetic audio event clocks", () => {
  it("anchors native-rate windows to frame timestamps across frame boundaries", () => {
    const { probe, pcm } = fixture(2000, 2200, 48000);
    const observed = inspectSyntheticAudio(probe, pcm);
    expect(observed).toMatchObject({ status: "observed", sampleRateHz: 48000, probedSamples: 192000,
      decodedSamples: 192000, event: { startMs: 2000 } });
    expect(observed.event!.endMs).toBeCloseTo(2200, 3);
    expect(observed.maximumClockErrorMs).toBeLessThanOrEqual(0.001);
    expect(observed.windows[9]).toMatchObject({ firstSample: 2160, samples: 240 });
    expect(observed.windows[9].timeMs).toBeCloseTo(45, 3);
  });
  it("compares both event boundaries and retains fixture-only scope", () => {
    const { probe, pcm } = fixture(1000, 1200);
    expect(compareSyntheticAudio(source(), inspectSyntheticAudio(probe, pcm), mapping)).toMatchObject({
      scope: "synthetic_audio_event_only", status: "matched", expectedEvent: { startMs: 1000, endMs: 1200 },
      startDeltaMs: 0, endDeltaMs: 0, toleranceMs: 10.125 });
  });
  it("rejects a 500 ms wrong range with the same declared mapping", () => {
    const { probe, pcm } = fixture(1500, 1700);
    expect(compareSyntheticAudio(source(), inspectSyntheticAudio(probe, pcm), mapping)).toMatchObject({
      status: "mismatch", reason: "artifact_event_mismatch", startDeltaMs: 500, endDeltaMs: 500 });
  });
  it("rejects a matching source/output pair with the wrong source event", () => {
    const { probe, pcm } = fixture(2500, 2700); const wrong = inspectSyntheticAudio(probe, pcm);
    expect(compareSyntheticAudio(wrong, wrong, { sourceStartMs: 0, sourceEndMs: 4000 }))
      .toMatchObject({ status: "mismatch", reason: "source_event_mismatch" });
  });
  it.each(["container", "audio", "frame"])("refuses a nonzero %s start and preserves the clock", (kind) => {
    const { probe, pcm } = fixture();
    if (kind === "container") probe.format.start_time = "1";
    if (kind === "audio") probe.streams[0].start_time = "1";
    if (kind === "frame") probe.frames[0].best_effort_timestamp_time = "1";
    const result = inspectSyntheticAudio(probe, pcm);
    expect(result).toMatchObject({ status: "unavailable", reason: "unsupported_nonzero_start", event: null });
    expect(Object.values(result.clocks!)).toContain(1000);
  });
  it("does not substitute sample index zero for missing stream/container clocks", () => {
    const { probe, pcm } = fixture();
    expect(inspectSyntheticAudio({ ...probe, format: { duration: "4" } }, pcm)).toMatchObject({ reason: "missing_start_clock" });
    expect(inspectSyntheticAudio({ ...probe, streams: [{ codec_name: "flac", sample_rate: "16000", channels: 1 }] }, pcm))
      .toMatchObject({ reason: "missing_start_clock" });
  });
  it.each(["missing", "duplicate", "backward", "gap", "drift"])("refuses %s sample clocks", (kind) => {
    const { probe, pcm } = fixture();
    probe.frames[10].best_effort_timestamp_time = kind === "missing" ? "N/A" : kind === "duplicate" ? "0.576" :
      kind === "backward" ? "0.001" : kind === "gap" ? "0.7" : "0.640010";
    expect(inspectSyntheticAudio(probe, pcm).status).toBe("unavailable");
  });
  it.each(["rate", "stereo", "codec"])("refuses an unsupported %s", (kind) => {
    const { probe, pcm } = fixture();
    if (kind === "rate") probe.streams[0].sample_rate = "44100";
    if (kind === "stereo") probe.streams[0].channels = 2;
    if (kind === "codec") probe.streams[0].codec_name = "pcm_f32le";
    expect(inspectSyntheticAudio(probe, pcm)).toMatchObject({ reason: "missing_or_unsupported_probe" });
  });
  it("checks sample totals, partial raw samples, and fixture bounds before reading floats", () => {
    const { probe, pcm } = fixture();
    for (const bytes of [pcm.subarray(1), pcm.subarray(4)]) expect(inspectSyntheticAudio(probe, bytes).reason).toBe("sample_count_mismatch");
    expect(inspectSyntheticAudio(probe, null).reason).toBe("decode_required");
    probe.frames[0].nb_samples = 65536;
    expect(inspectSyntheticAudio(probe, pcm).reason).toBe("fixture_limit_exceeded");
  });
  it.each([NaN, Infinity, 2])("refuses invalid fixture PCM %s", (value) => {
    const { probe, pcm } = fixture(); pcm.writeFloatLE(value, 0);
    expect(inspectSyntheticAudio(probe, pcm)).toMatchObject({ reason: "invalid_fixture_pcm", event: null });
  });
  it.each(["absent", "repeated", "intermediate", "short", "edge"])("cannot match an %s event", (kind) => {
    const { probe, pcm } = fixture(kind === "edge" ? 0 : 2000, kind === "edge" ? 200 : kind === "short" ? 2100 : 2200);
    if (kind === "absent") pcm.fill(0);
    if (kind === "repeated") for (let i = 8000; i < 11200; i++) pcm.writeFloatLE(0.3, i * 4);
    if (kind === "intermediate") for (let i = 0; i < 80; i++) pcm.writeFloatLE(0.05, i * 4);
    const result = inspectSyntheticAudio(probe, pcm);
    expect(result).toMatchObject({ status: "unavailable", event: null });
    expect(compareSyntheticAudio(source(), result, mapping).status).toBe("unavailable");
  });
  it("refuses an interval outside the fixture or excluding the event", () => {
    for (const invalid of [{ sourceStartMs: NaN, sourceEndMs: 3000 }, { sourceStartMs: 0, sourceEndMs: 5000 },
      { sourceStartMs: 2000, sourceEndMs: 2200 }]) expect(compareSyntheticAudio(source(), source(), invalid).status).toBe("unavailable");
  });
});
