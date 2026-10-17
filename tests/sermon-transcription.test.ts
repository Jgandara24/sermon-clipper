import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildAnalysisDerivatives } from "@/lib/media/analysis-derivatives";
import { extractSermonAudio } from "@/lib/media/sermon-audio";
import { fileIdentity } from "@/lib/storage/file-identity";
import { requestScribe, ScribeTranscriptionProvider } from "@/lib/transcription/scribe-provider";
import { transcribeVerifiedSermonAudio } from "@/lib/transcription/sermon-audio";

let root: string;
let base: Omit<Parameters<typeof transcribeVerifiedSermonAudio>[0], "provider">;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sermon-transcription-"));
  const sourcePath = path.join(root, "source.mov");
  await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=96x64:d=2:r=25",
    "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=2", "-c:v", "libx264", "-threads", "1",
    "-c:a", "pcm_s16le", sourcePath]);
  const identity = await fileIdentity(sourcePath), sourceVideoId = randomUUID();
  const built = await buildAnalysisDerivatives({ ...identity, sourcePath, sourceVideoId, sessionId: randomUUID(),
    directory: root, width: 96, height: 64, transcriptRevision: 0, download: undefined }, {
    proxyCrf: 18, proxyPreset: "ultrafast", proxyAudioBitrateBps: 64000, flacCompressionLevel: 5,
    encoderThreads: 1, timeoutMs: 30000,
  });
  const audio = await extractSermonAudio({ path: built.analysis.path, sha256: built.analysis.sha256,
    byteCount: built.analysis.byteCount, sourceInterval: built.analysis.sourceInterval }, {
    sourceInterval: { startMs: 333, endMs: 1777 }, detectorVersion: "fixture-only-v1",
    evidenceSha256: "b".repeat(64), confidence: 0.9,
  }, root, { threads: 1, flacCompressionLevel: 5, timeoutMs: 30000, maxMetadataBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 });
  base = { sourceVideoId, sourceSha256: identity.sha256, analysis: built.analysis, audio };
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllGlobals(); });
function provider(end = 1) {
  const request = vi.fn(async () => ({ language_code: "en", text: "Hello.", words: [
    { type: "word" as const, text: "Hello.", start: 0.1, end, speaker_id: "speaker", logprob: -0.2 },
    { type: "audio_event" as const, text: "[music]", start: 0, end: 0.1 },
  ] }));
  return { request, provider: new ScribeTranscriptionProvider({ apiKey: "fixture-only", request }) };
}
describe("one verified sermon audio submission", () => {
  it("submits only the selected FLAC once and returns complete mapped provenance", async () => {
    const fixture = provider();
    const output = await transcribeVerifiedSermonAudio({ ...base, provider: fixture.provider });
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ audioPath: base.audio.path, keyterms: [] }));
    expect(output.result.segments[0].words[0]).toMatchObject({ startMs: 433, endMs: 1333 });
    expect(output.provenance).toMatchObject({ sourceVideoId: base.sourceVideoId, sourceSha256: base.sourceSha256,
      submittedAudioSha256: base.audio.sha256, submittedDurationMs: 1444, sourceOffsetMs: 333,
      sourceInterval: { startMs: 333, endMs: 1777 }, capabilities: { wordTimestamps: { status: "derived" } } });
    expect(output.result.providerEvidence?.sourceOffsetMs).toBe(333);
    expect(output.submission).toMatchObject({ requestCount: 1, noVerbatim: false, corridorConfidence: 0.9 });
  });
  it("sends FLAC with the correct MIME type and base Scribe request settings", async () => {
    let form: FormData | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      form = init.body as FormData;
      return new Response(JSON.stringify({ language_code: "en", text: "Hello.", words: [] }), { status: 200 });
    }));
    await requestScribe({ apiKey: "fixture-only", audioPath: base.audio.path, keyterms: [] });
    expect((form!.get("file") as File).type).toBe("audio/flac");
    expect(form!.get("model_id")).toBe("scribe_v2");
    expect(form!.get("no_verbatim")).toBe("false");
    expect(form!.getAll("keyterms")).toEqual([]);
  });

  it("refuses a broken proof chain before provider work", async () => {
    const fixture = provider();
    await expect(transcribeVerifiedSermonAudio({ ...base, sourceSha256: "c".repeat(64), provider: fixture.provider }))
      .rejects.toThrow("MAPPING_INVALID");
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it("does not retry or expand the corridor after a provider failure", async () => {
    const fixture = provider();
    fixture.request.mockRejectedValue(new Error("fixture provider failure"));
    await expect(transcribeVerifiedSermonAudio({ ...base, provider: fixture.provider })).rejects.toThrow("fixture provider failure");
    expect(fixture.request).toHaveBeenCalledTimes(1);
  });
  it("refuses provider times beyond submitted audio instead of silently clipping them", async () => {
    const fixture = provider(2);
    await expect(transcribeVerifiedSermonAudio({ ...base, provider: fixture.provider })).rejects.toThrow("OUTSIDE_CORRIDOR");
    expect(fixture.request).toHaveBeenCalledTimes(1);
  });
});
