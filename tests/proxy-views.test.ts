import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildProxyView, proxyViewEvidenceSchema, type ProxyViewRequest } from "@/lib/media/proxy-views";
import { prepareAnthropicVisualBoundaryRequest } from "@/lib/media/anthropic-visual-escalation";
import { visualEscalationPreparedIdentity } from "@/lib/media/visual-escalation";
import { fileIdentity } from "@/lib/storage/file-identity";
const run = promisify(execFile);
let root: string, work: string, video: string;
const request: ProxyViewRequest = { kind: "TIMELINE_VIEW", sourceTimesMs: [5000, 6000, 7000], columns: 2,
  tileHeight: 32, maxPixels: 100000, maxFileBytes: 1048576,
  frames: { quality: 75, threads: 1, maxFrames: 10, maxFrameBytes: 1048576, maxTotalBytes: 10485760,
    maxOutputBytes: 1048576, timeoutMs: 30000 } };
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "proxy-view-test-")); work = path.join(root, "work"); await mkdir(work);
  video = path.join(root, "proxy.mkv");
  await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=96x64:d=1:r=10",
    "-f", "lavfi", "-i", "color=white:s=96x64:d=1:r=10", "-f", "lavfi", "-i", "color=red:s=96x64:d=1:r=10",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-c:v", "ffv1", "-threads", "1", video]);
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const input = async () => ({ path: video, ...await fileIdentity(video), mapping: {
  sourceInterval: { startMs: 5000, endMs: 8000 }, artifactOriginMs: 0, timeScale: "1:1" as const } });
it.each(["TIMELINE_VIEW", "BOUNDARY_STRIP"] as const)("builds %s in source order with a truthful cell map", async kind => {
  const result = await buildProxyView(await input(), { ...request, kind }, work);
  expect(result.evidence).toMatchObject({ width: 96, height: 64, emptyCells: 1, coverage: "sampled-instants-only" });
  expect(result.evidence.cells.map(cell => [cell.sourceTimeMs, cell.x, cell.y])).toEqual([[5000, 0, 0], [6000, 48, 0], [7000, 0, 32]]);
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", result.path, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { encoding: "buffer" });
  const pixel = (x: number, y: number) => [...stdout.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4)];
  expect(pixel(10, 10)).toEqual([0, 0, 0, 255]);
  expect(pixel(60, 10)).toEqual([255, 255, 255, 255]);
  expect(pixel(10, 40)[0]).toBeGreaterThan(240);
  expect(pixel(60, 40)).toEqual([0, 0, 0, 255]);
  expect(await fileIdentity(result.path)).toEqual({ sha256: result.sha256, byteCount: result.byteCount });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "fixture", model: "fixture-model",
    stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ status: "AMBIGUOUS", reason: "Fixture." }) }],
    usage: { input_tokens: 10, output_tokens: 5 } }));
  const prepared = prepareAnthropicVisualBoundaryRequest({ settings: { model: "fixture-model", policyVersion: "fixture",
    contextCeiling: { model: "fixture-model", maxInputTokens: 100, evidenceReference: "fixture" },
    budget: { maxInputTokens: 100, maxOutputTokens: 20, inputMicroUsdPerMillionTokens: 1000000,
      outputMicroUsdPerMillionTokens: 2000000, budgetMicroUsd: 140, priceEvidenceReference: "fixture" },
    maxImageBytes: 1048576, maxRequestBytes: 2097152, maxResponseBytes: 10000, timeoutMs: 1000 },
    evidence: {}, images: [{ artifactId: "11111111-1111-4111-8111-111111111111", kind, sha256: result.sha256,
      byteCount: result.byteCount, bytes: await readFile(result.path), viewEvidence: result.evidence }] },
  { apiKey: "fixture", fetchImpl: fetcher });
  expect(fetcher).not.toHaveBeenCalled();
  result.evidence.cells[0].sourceTimeMs = 999;
  await prepared.submit({ escalationId: "22222222-2222-4222-8222-222222222222",
    preparedRequestSha256: prepared.request.preparedRequestSha256,
    preparedConfigurationSha256: visualEscalationPreparedIdentity(prepared.request), maxInputTokens: 100, maxOutputTokens: 20 });
  const content = JSON.parse(String(fetcher.mock.calls[0][1]?.body)).messages[0].content;
  expect(content[0].text).toContain('"sourceTimeMs":5000');
  expect(content[0].text).toContain('"emptyCells":1');
  expect(content[0].text).toContain("never continuous coverage");
  expect(Buffer.from(content[1].source.data, "base64")).toEqual(await readFile(result.path));
  expect(fetcher).toHaveBeenCalledTimes(1);
  await rm(path.dirname(result.path), { recursive: true });
});
it("rejects invalid composite maps before request preparation", async () => {
  const result = await buildProxyView(await input(), request, work);
  for (const mode of ["index", "overlap", "dimensions", "order", "interval", "empty", "coverage", "missing-cells"] as const) {
    const evidence = structuredClone(result.evidence);
    if (mode === "index") evidence.cells[1].index = 0;
    if (mode === "overlap") evidence.cells[1].x = 0;
    if (mode === "dimensions") evidence.cells[1].width++;
    if (mode === "order") evidence.cells[1].sourceTimeMs = 5000;
    if (mode === "interval") evidence.sourceInterval.endMs++;
    if (mode === "empty") evidence.emptyCells++;
    if (mode === "coverage") Reflect.set(evidence, "coverage", "continuous");
    if (mode === "missing-cells") evidence.cells = [];
    expect(proxyViewEvidenceSchema.safeParse(evidence).success).toBe(false);
  }
  await rm(path.dirname(result.path), { recursive: true });
});
it("refuses absent frame times and bounded-output failures without retained local files", async () => {
  await expect(buildProxyView(await input(), { ...request, sourceTimesMs: [5050, 6000] }, work)).rejects.toThrow();
  await expect(buildProxyView(await input(), { ...request, maxPixels: 1 }, work)).rejects.toThrow("PIXEL_LIMIT");
  await expect(buildProxyView(await input(), { ...request, maxFileBytes: 1 }, work)).rejects.toThrow("FILE_LIMIT");
  expect(await readdir(work)).toEqual([]);
});
