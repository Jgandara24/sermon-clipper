import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractAudioEvidence, type AudioEvidenceSettings } from "@/lib/media/audio-evidence";
import { fileIdentity } from "@/lib/storage/file-identity";

const run = promisify(execFile);
let root: string, audio: string;
const settings: AudioEvidenceSettings = { silenceNoiseDb: -40, silenceMinimumMs: 200,
  waveformWindowSamples: 1600, threads: 1, timeoutMs: 30000, maxMetadataBytes: 1024 * 1024 };
async function makeAudio(name: string, expression: string, samples: number, sampleRate = 16000) {
  const file = path.join(root, name);
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `aevalsrc=${expression}:s=${sampleRate}`,
    "-af", `atrim=end_sample=${samples}`, "-c:a", "flac", file], { timeout: 30000 });
  return file;
}
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "audio-evidence-"));
  audio = await makeAudio("sequence.flac", "if(between(t\\,1\\,2)\\,0.5*sin(2*PI*440*t)\\,0)", 48000);
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function input(file = audio, startMs = 5000, durationMs = 3000) {
  return { path: file, ...await fileIdentity(file), mapping: {
    sourceInterval: { startMs, endMs: startMs + durationMs }, artifactOriginMs: 0, timeScale: "1:1" as const,
  } };
}
describe("analysis audio evidence", () => {
  it("maps silence and waveform measurements into source time", async () => {
    const facts = await extractAudioEvidence(await input(), settings);
    expect(facts.totalSamples).toBe(48000);
    expect(facts.waveform).toHaveLength(30);
    expect(facts.observedStartMs).toBe(5000);
    expect(facts.observedEndMs).toBe(8000);
    expect(facts.silence).toEqual([
      { startMs: 5000, endMs: 6000, endReason: "DETECTED" },
      { startMs: 7000, endMs: 8000, endReason: "OBSERVED_AUDIO_END" },
    ]);
    expect(facts.waveform[0]).toMatchObject({ sampleCount: 1600, peakAmplitude: 0, rmsAmplitude: 0 });
    expect(facts.waveform[15].peakAmplitude).toBeCloseTo(0.5, 4);
    expect(facts.waveform[15].rmsAmplitude).toBeCloseTo(0.5 / Math.sqrt(2), 4);
  });
  it("counts a single-sample final window without padding the audio", async () => {
    const file = await makeAudio("partial.flac", "0", 16001);
    const facts = await extractAudioEvidence(await input(file, 0, 1001), settings);
    expect(facts.totalSamples).toBe(16001);
    expect(facts.waveform.at(-1)?.sampleCount).toBe(1);
    expect(facts.observedEndMs).toBe(1000);
    expect(facts.waveform.reduce((sum, window) => sum + window.sampleCount, 0)).toBe(16001);
  });
  it("stops trailing silence at observed audio end instead of a longer declared interval", async () => {
    const file = await makeAudio("short.flac", "0", 8000);
    const facts = await extractAudioEvidence(await input(file, 0, 3000), settings);
    expect(facts.silence).toEqual([{ startMs: 0, endMs: 500, endReason: "OBSERVED_AUDIO_END" }]);
  });
  it("handles an old silence ending and a new silence starting in one waveform window", async () => {
    const file = await makeAudio("transition.flac", "if(between(t\\,0.25\\,0.28)\\,0.5\\,0)", 12000);
    const facts = await extractAudioEvidence(await input(file, 0, 750), settings);
    expect(facts.silence).toHaveLength(2);
    expect(facts.silence[0].endMs).toBe(250);
    expect(facts.silence[1].startMs).toBe(280);
  });
  it("refuses an incompatible sample rate and changed bytes", async () => {
    const file = await makeAudio("wrong-rate.flac", "0", 8000, 8000);
    await expect(extractAudioEvidence(await input(file), settings)).rejects.toThrow("MEDIA_ANALYSIS_AUDIO_FORMAT_REQUIRED");
    await expect(extractAudioEvidence({ ...await input(), sha256: "a".repeat(64) }, settings)).rejects.toThrow("MEDIA_AUDIO_INPUT_CHANGED");
  });
  it("rejects source interval overflow and unsafe waveform resolution", async () => {
    await expect(extractAudioEvidence(await input(audio, 0, 1000), settings)).rejects.toThrow("outside the artifact interval");
    await expect(extractAudioEvidence(await input(), { ...settings, waveformWindowSamples: 16000 })).rejects.toThrow("minimum silence");
  });
  it("versions thresholds and waveform settings without including execution limits", async () => {
    const request = await input();
    const first = await extractAudioEvidence(request, settings);
    const second = await extractAudioEvidence(request, { ...settings, timeoutMs: 60000 });
    const third = await extractAudioEvidence(request, { ...settings, silenceNoiseDb: -50 });
    expect(second.configurationSha256).toBe(first.configurationSha256);
    expect(third.configurationSha256).not.toBe(first.configurationSha256);
  });
});
