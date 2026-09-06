import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthProvider, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as mediaRoute } from "@/app/api/media/signed/route";
import { createSignedMediaUrl } from "@/lib/media/signed-url";
import { getStorageProvider } from "@/lib/storage";

/**
 * The byte-range serving a candidate preview is built on.
 *
 * A preview never renders anything: it asks this route for the slice of the sermon recording that
 * one candidate covers, and the browser only asks for the bytes it needs to play. That behaviour
 * rests entirely on the route answering a `Range` header with `206` and an honest `Content-Range`,
 * so those are asserted here rather than assumed by the UI that depends on them.
 */

const prisma = new PrismaClient();
const BODY = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));

let workspaceId: string;
let userId: string;
let key: string;
let absolutePath: string;

function requestFor(signedPath: string, range?: string): Request {
  return new Request(`http://localhost${signedPath}`, {
    headers: range ? { range } : undefined,
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `media-range-${Date.now()}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { ownerId: user.id, name: "Byte range tests" },
  });
  workspaceId = workspace.id;

  key = `${workspaceId}/src/sermon.mp4`;
  absolutePath = getStorageProvider().absolutePath(key);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, BODY);
});

afterAll(async () => {
  await rm(absolutePath, { force: true });
  if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

function signed() {
  return createSignedMediaUrl({ key, workspaceId, contentType: "video/mp4" });
}

describe("serving one slice of a recording", () => {
  it("advertises byte ranges, so a browser knows it may ask for part of the file", async () => {
    const response = await mediaRoute(requestFor(signed()));
    expect(response.status).toBe(200);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe(String(BODY.length));
  });

  it("returns exactly the requested bytes, and says which they were", async () => {
    const response = await mediaRoute(requestFor(signed(), "bytes=1000-1999"));
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 1000-1999/${BODY.length}`);
    expect(response.headers.get("Content-Length")).toBe("1000");

    const body = Buffer.from(await response.arrayBuffer());
    expect(body).toHaveLength(1000);
    expect(body.equals(BODY.subarray(1000, 2000))).toBe(true);
  });

  it("serves an open-ended range to the end of the file", async () => {
    const response = await mediaRoute(requestFor(signed(), "bytes=4000-"));
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 4000-4095/${BODY.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toHaveLength(96);
  });

  it("refuses a range past the end rather than serving something shorter", async () => {
    const response = await mediaRoute(requestFor(signed(), "bytes=4000-99999"));
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${BODY.length}`);
  });

  /**
   * A preview link is a normal signed link, so every rule that governs one governs it. Worth
   * pinning here because a preview is the first thing that hands a media URL to a page holding a
   * dozen of them, and a cross-workspace key would be the expensive mistake to make at that scale.
   */
  it("still refuses a key from another workspace, range or no range", async () => {
    const foreignWorkspace = await prisma.workspace.create({
      data: { ownerId: userId, name: "Byte range foreign" },
    });
    try {
      // Signed correctly for its own workspace, then asked for under another one's id.
      const url = new URL(`http://localhost${signed()}`);
      url.searchParams.set("workspaceId", foreignWorkspace.id);
      const response = await mediaRoute(new Request(url, { headers: { range: "bytes=0-99" } }));
      expect(response.status).toBe(403);
    } finally {
      await prisma.workspace.delete({ where: { id: foreignWorkspace.id } });
    }
  });

  it("refuses an expired link before it reads a byte", async () => {
    const expired = createSignedMediaUrl({
      key,
      workspaceId,
      contentType: "video/mp4",
      expiresInSeconds: -60,
    });
    const response = await mediaRoute(requestFor(expired, "bytes=0-99"));
    expect(response.status).toBe(410);
  });
});
