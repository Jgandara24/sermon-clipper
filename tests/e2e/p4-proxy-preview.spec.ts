import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { prisma } from "../../src/lib/prisma";
import { getStorageProvider } from "../../src/lib/storage";
import { runAnalysisDerivativeBatch } from "../../src/lib/media/analysis-batch";
import { ANALYSIS_RETAINED_CLIP_STATUS } from "../../src/lib/analysis/clip-status";
import { signInAs, signOutTestSessions } from "./auth-session";

test.skip(process.env.P4_BROWSER_TEST !== "1", "Requires disposable P4 browser database.");
test("plays the registered proxy after original deletion without creating an export", async ({ page, context }) => {
  const root = process.env.P4_BROWSER_ROOT!;
  const storage = getStorageProvider();
  const owner = await prisma.user.create({ data: { email: `p4-browser-${randomUUID()}@example.test` } });
  const workspace = await prisma.workspace.create({ data: { ownerId: owner.id, name: "Proxy browser fixture" } });
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });
  const key = `${workspace.id}/source.mp4`;
  await mkdir(path.dirname(storage.absolutePath(key)), { recursive: true });
  await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
    "testsrc2=s=192x108:d=4:r=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-shortest", storage.absolutePath(key)], { timeout: 30000 });
  const source = await prisma.sourceVideo.create({ data: { workspaceId: workspace.id, origin: "UPLOAD", storageKey: key,
    width: 192, height: 108, durationS: 4, filename: "generated.mp4" } });
  const project = await prisma.project.create({ data: { workspaceId: workspace.id, sourceVideoId: source.id,
    name: "Generated proxy service", status: "READY" } });
  await prisma.generatedClip.create({ data: { workspaceId: workspace.id, projectId: project.id, rank: 1,
    startMs: 1000, endMs: 2000, title: "Generated candidate", summary: "Generated media for browser verification.", status: ANALYSIS_RETAINED_CLIP_STATUS } });
  const batch = await runAnalysisDerivativeBatch(prisma, storage, { workspaceId: workspace.id, sourceVideoId: source.id,
    ownerId: randomUUID(), temporaryRoot: path.join(root, "work") }, { proxyCrf: 18, proxyPreset: "ultrafast",
    proxyAudioBitrateBps: 64000, flacCompressionLevel: 5, encoderThreads: 1, timeoutMs: 30000 },
  { analysisExpiresAt: new Date(Date.now() + 3600000), previewExpiresAt: new Date(Date.now() + 3600000) },
  undefined, undefined, undefined, undefined, [{ kind: "TIMELINE_VIEW", sourceTimesMs: [0, 1000, 2000],
    columns: 2, tileHeight: 120, maxPixels: 1000000, maxFileBytes: 1048576,
    frames: { quality: 75, threads: 1, maxFrames: 10, maxFrameBytes: 1048576, maxTotalBytes: 10485760,
      maxOutputBytes: 1048576, timeoutMs: 30000 } }]);
  // Delete only this generated fixture's original. This does not exercise production deletion policy.
  await storage.remove(key);
  await prisma.sourceVideo.update({ where: { id: source.id }, data: { storageKey: null } });
  const mediaRequests: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/media/")) mediaRequests.push(request.url()); });
  await signInAs(context, owner.id);
  await page.goto(`/app/projects/${project.id}`);
  await expect(page.getByRole("heading", { name: "Generated candidate" })).toBeVisible();
  await expect(page.getByTestId("preview-video")).toHaveCount(0);
  expect(mediaRequests).toHaveLength(0);
  await page.getByTestId("preview-toggle").click();
  const video = page.getByTestId("preview-video");
  await expect(video).toHaveAttribute("preload", "none");
  expect(await video.getAttribute("src")).toContain("/api/media/artifact?");
  const response = page.waitForResponse(response => response.url().includes("/api/media/artifact?"));
  await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
  expect((await response).status()).toBe(206);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoHeight)).toBe(480);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1.1);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(1, 1);
  expect(mediaRequests.every(url => url.includes("/api/media/artifact?"))).toBe(true);
  expect(await prisma.exportJob.count({ where: { clip: { projectId: project.id } } })).toBe(0);
  expect(await prisma.sourceVideo.findUnique({ where: { id: source.id } })).toMatchObject({ width: 192, height: 108, storageKey: null });
  expect(await storage.exists(batch.proxy.artifact.storageKey)).toBe(true);
  const operator = await prisma.user.create({ data: { email: `p4-operator-${randomUUID()}@example.test`, isPlatformOperator: true } });
  const staff = await prisma.workspace.create({ data: { ownerId: operator.id, name: "Separate staff workspace" } });
  await prisma.workspaceMember.create({ data: { workspaceId: staff.id, userId: operator.id, role: "OWNER", status: "ACTIVE" } });
  await context.clearCookies();
  await signInAs(context, operator.id);
  await page.goto(`/app/operator/projects/${project.id}`);
  await page.getByTestId("preview-toggle").click();
  await expect(page.getByTestId("source-view-images")).toBeVisible();
  await expect(page.getByTestId("source-view-image")).toHaveCount(0);
  const imageResponse = page.waitForResponse(response => response.url().includes("contentType=image%2Fwebp"));
  await page.getByTestId("source-view-toggle").click();
  expect((await imageResponse).status()).toBe(200);
  await expect.poll(() => page.getByTestId("source-view-image").evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText("2: 0:00:01.000", { exact: true })).toBeVisible();
  await page.getByTestId("source-view-images").screenshot({ path: path.join(root, "operator-views.png") });
  const operatorVideo = page.getByTestId("preview-video");
  const operatorResponse = page.waitForResponse(response => response.url().includes("/api/media/artifact?"));
  await operatorVideo.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
  expect((await operatorResponse).status()).toBe(206);
  await expect.poll(() => operatorVideo.evaluate((element: HTMLVideoElement) => element.videoHeight)).toBe(480);
  await expect.poll(() => operatorVideo.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1.1);
  await expect.poll(() => operatorVideo.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  expect(await prisma.exportJob.count({ where: { clip: { projectId: project.id } } })).toBe(0);

});
test.afterAll(async () => { await signOutTestSessions(); await prisma.$disconnect(); });
