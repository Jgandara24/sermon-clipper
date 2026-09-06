import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { MemberStatus, WorkspaceRole } from "@prisma/client";
import { ANALYSIS_RETAINED_CLIP_STATUS } from "../../src/lib/analysis/clip-status";
import { prisma } from "../../src/lib/prisma";
import { getStorageProvider } from "../../src/lib/storage";
import { signInAs, signOutTestSessions } from "./auth-session";

process.env.STORAGE_LOCAL_ROOT = path.join(process.cwd(), ".data", "e2e-storage");

/**
 * Previewing a candidate's moment without rendering anything.
 *
 * The claims worth a real browser: that opening a service downloads nothing, that one preview
 * opens at a time, that it plays the candidate's own span and stops at the end of it, and that a
 * purged recording produces an honest absence rather than a link that fails at playback.
 */

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
let serial = 0;

type Fixture = {
  ownerId: string;
  operatorId: string;
  workspaceId: string;
  projectId: string;
  purgedProjectId: string;
  firstClipId: string;
};

let fixture: Fixture;

function uniqueKey(label: string) {
  serial += 1;
  return `${label}-${serial}-${Date.now()}`;
}

async function buildFixture(): Promise<Fixture> {
  const owner = await prisma.user.create({
    data: { email: `${uniqueKey("preview-owner")}@example.com` },
  });
  const operator = await prisma.user.create({
    data: { email: `${uniqueKey("preview-op")}@example.com`, isPlatformOperator: true },
  });
  createdUserIds.push(owner.id, operator.id);

  const workspace = await prisma.workspace.create({
    data: { ownerId: owner.id, name: "Preview Church" },
  });
  const operatorWorkspace = await prisma.workspace.create({
    data: { ownerId: operator.id, name: "Preview Staff" },
  });
  createdWorkspaceIds.push(workspace.id, operatorWorkspace.id);
  for (const [ws, user] of [
    [workspace.id, owner.id],
    [operatorWorkspace.id, operator.id],
  ] as const) {
    await prisma.workspaceMember.create({
      data: { workspaceId: ws, userId: user, role: WorkspaceRole.OWNER, status: MemberStatus.ACTIVE },
    });
  }

  // A real file behind the key: the preview asks for byte ranges of it.
  const storageKey = `${workspace.id}/src/preview.mp4`;
  const absolutePath = getStorageProvider().absolutePath(storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, Buffer.alloc(64 * 1024, 3));

  const video = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: "UPLOAD",
      filename: "preview.mp4",
      storageKey,
      language: "en",
    },
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: "Preview Service", sourceVideoId: video.id },
  });

  // A service whose recording retention has already purged: the row survives, the key does not.
  const purgedVideo = await prisma.sourceVideo.create({
    data: {
      workspaceId: workspace.id,
      origin: "UPLOAD",
      filename: "purged.mp4",
      storageKey: null,
      language: "en",
    },
  });
  const purgedProject = await prisma.project.create({
    data: { workspaceId: workspace.id, name: "Purged Service", sourceVideoId: purgedVideo.id },
  });

  const clips = [];
  for (const rank of [1, 2, 3]) {
    clips.push(
      await prisma.generatedClip.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
          rank,
          // Distinct, checkable spans: 60–90s, 120–150s, 180–210s.
          startMs: rank * 60_000,
          endMs: rank * 60_000 + 30_000,
          title: `Preview candidate ${rank}`,
          hookText: `Hook ${rank}`,
          summary: `Summary ${rank}.`,
          status: ANALYSIS_RETAINED_CLIP_STATUS,
        },
      }),
    );
  }
  await prisma.generatedClip.create({
    data: {
      workspaceId: workspace.id,
      projectId: purgedProject.id,
      rank: 1,
      startMs: 0,
      endMs: 30_000,
      title: "Purged candidate",
      summary: "Its recording is gone.",
      status: ANALYSIS_RETAINED_CLIP_STATUS,
    },
  });

  return {
    ownerId: owner.id,
    operatorId: operator.id,
    workspaceId: workspace.id,
    projectId: project.id,
    purgedProjectId: purgedProject.id,
    firstClipId: clips[0].id,
  };
}

test.beforeAll(async () => {
  fixture = await buildFixture();
});

test.afterAll(async () => {
  await signOutTestSessions();
  await prisma.publishAttempt.deleteMany({
    where: { scheduledPost: { workspaceId: { in: createdWorkspaceIds } } },
  });
  await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

test.describe("Candidate previews", () => {
  /**
   * The cheap part, and the reason `preload="none"` and conditional mounting are both used: a
   * service holds a dozen candidates, and opening the page must fetch none of them.
   */
  test("downloads nothing until somebody asks", async ({ page, context }) => {
    const mediaRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/media/signed")) mediaRequests.push(request.url());
    });

    await signInAs(context, fixture.ownerId);
    await page.goto(`/app/projects/${fixture.projectId}`);
    // By role: each preview button carries the candidate's title in a screen-reader label, so a
    // plain text match finds the heading and the button both.
    await expect(page.getByRole("heading", { name: "Preview candidate 1" })).toBeVisible();

    // Three candidates on the page, no video element among them and no byte fetched.
    await expect(page.locator("video")).toHaveCount(0);
    await expect(page.getByTestId("preview-toggle")).toHaveCount(3);
    expect(mediaRequests).toHaveLength(0);
  });

  test("opens one preview at a time, and never plays on its own", async ({ page, context }) => {
    await signInAs(context, fixture.ownerId);
    await page.goto(`/app/projects/${fixture.projectId}`);

    await page.getByTestId("preview-toggle").first().click();
    const video = page.getByTestId("preview-video");
    await expect(video).toHaveCount(1);

    // Standard controls, no autoplay, and nothing fetched ahead of a press.
    await expect(video).toHaveAttribute("preload", "none");
    await expect(video).toHaveAttribute("controls", "");
    expect(await video.getAttribute("autoplay")).toBeNull();
    expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);

    // Opening a second closes the first: still exactly one element on the page.
    await page.getByTestId("preview-toggle").nth(1).click();
    await expect(page.getByTestId("preview-video")).toHaveCount(1);

    // And pressing the same one again closes it.
    await page.getByTestId("preview-toggle").nth(1).click();
    await expect(page.getByTestId("preview-video")).toHaveCount(0);
  });

  /**
   * One continuous span, clamped at both ends. The fragment carries the candidate's own range —
   * 60s to 90s for rank 1 — and there is deliberately no seeking logic that hops over anything
   * inside it, because a preview that skipped would show a cut the final render would not.
   */
  test("plays the candidate's own range and no other", async ({ page, context }) => {
    await signInAs(context, fixture.ownerId);
    await page.goto(`/app/projects/${fixture.projectId}`);

    await page.getByTestId("preview-toggle").first().click();
    const src = await page.getByTestId("preview-video").getAttribute("src");
    expect(src).toContain("#t=60.00,90.00");
    expect(src).toContain(`workspaceId=${fixture.workspaceId}`);

    await page.getByTestId("preview-toggle").first().click();
    await page.getByTestId("preview-toggle").nth(2).click();
    const third = await page.getByTestId("preview-video").getAttribute("src");
    expect(third).toContain("#t=180.00,210.00");
  });

  test("creates no export job, however many previews are opened", async ({ page, context }) => {
    const before = await prisma.exportJob.count({ where: { workspaceId: fixture.workspaceId } });

    await signInAs(context, fixture.ownerId);
    await page.goto(`/app/projects/${fixture.projectId}`);
    for (const index of [0, 1, 2]) {
      await page.getByTestId("preview-toggle").nth(index).click();
      await expect(page.getByTestId("preview-video")).toHaveCount(1);
    }

    const after = await prisma.exportJob.count({ where: { workspaceId: fixture.workspaceId } });
    expect(after).toBe(before);
  });

  /**
   * A purged recording is an honest absence. Signing a link to a key that is gone would produce a
   * perfectly valid URL that 404s at playback, which is the worst of both — it looks available
   * until someone presses it.
   */
  test("says so plainly when the recording has been deleted, and signs nothing", async ({
    page,
    context,
  }) => {
    await signInAs(context, fixture.ownerId);
    await page.goto(`/app/projects/${fixture.purgedProjectId}`);

    await expect(page.getByTestId("preview-unavailable")).toContainText(
      "recording for this service has been deleted",
    );
    await expect(page.getByTestId("preview-toggle")).toHaveCount(0);
    await expect(page.locator("video")).toHaveCount(0);
    expect(await page.content()).not.toContain("/api/media/signed");
  });

  test("gives an operator the same preview, signed for the church", async ({ page, context }) => {
    await signInAs(context, fixture.operatorId);
    await page.goto(`/app/operator/projects/${fixture.projectId}`);

    await page.getByTestId("preview-toggle").first().click();
    const src = await page.getByTestId("preview-video").getAttribute("src");
    // The church's workspace, never the operator's own.
    expect(src).toContain(`workspaceId=${fixture.workspaceId}`);
    expect(src).toContain("#t=60.00,90.00");

    // And the link actually serves a slice rather than being merely well-formed.
    const withoutFragment = (src as string).split("#")[0];
    const response = await page.request.get(withoutFragment, {
      headers: { range: "bytes=0-1023" },
    });
    expect(response.status()).toBe(206);
  });
});
