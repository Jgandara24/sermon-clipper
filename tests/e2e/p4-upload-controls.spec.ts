import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../../src/lib/prisma";
import { signInAs, signOutTestSessions } from "./auth-session";

test.skip(process.env.P4_BROWSER_TEST !== "1", "Requires disposable P4 browser database.");
test("shows confirmed upload progress and cancels the same session", async ({ page, context }) => {
  const owner = await prisma.user.create({ data: { email: `p4-upload-${randomUUID()}@example.test` } });
  const workspace = await prisma.workspace.create({ data: { ownerId: owner.id, name: "Upload controls fixture" } });
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });
  const uploadId = randomUUID();
  const actions: string[] = [];
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/uploads/presign", route => route.fulfill({ json: { data: {
    uploadId, transport: "multipart", partBytes: 3, totalBytes: 8,
  } } }));
  await page.route(`**/api/uploads/${uploadId}/multipart`, async route => {
    const body = route.request().postDataJSON();
    actions.push(body.action);
    if (body.action === "start") return route.fulfill({ json: { data: { state: "UPLOADING" } } });
    if (body.action === "list") return route.fulfill({ json: { data: { parts: [] } } });
    if (body.action === "abort") return route.fulfill({ json: { data: { state: "ABORTED" } } });
    if (body.action !== "sign") throw new Error("Unexpected fixture action.");
    if (body.partNumber === 2) await delayed;
    await route.fulfill({ json: { data: { uploadUrl: `http://127.0.0.1:3219/fixture-storage/${body.partNumber}` } } }).catch(() => {});
  });
  await page.route("**/fixture-storage/*", route => route.fulfill({ status: 200, body: "" }));
  try {
    await signInAs(context, owner.id);
    await page.goto("/app");
    await page.getByLabel("Video file", { exact: true }).setInputFiles({ name: "fixture.mp4", mimeType: "video/mp4", buffer: Buffer.from("abcdefgh") });
    await page.getByRole("button", { name: "Upload & process" }).click();
    await expect(page.getByRole("progressbar")).toHaveAttribute("value", "37");
    await expect(page.getByText("Uploaded 37%", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel upload", exact: true }).click();
    await expect(page.getByRole("button", { name: "Upload & process" })).toBeEnabled();
    expect(actions.filter(action => action === "abort")).toHaveLength(1);
    expect(actions).not.toContain("complete");
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    expect(await prisma.sourceVideo.count({ where: { workspaceId: workspace.id } })).toBe(0);
  } finally {
    release();
    await signOutTestSessions();
    await prisma.$disconnect();
  }
});
