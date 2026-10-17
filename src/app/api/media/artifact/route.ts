import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getStorageProvider } from "@/lib/storage";
import { verifySignedMediaUrl } from "@/lib/media/signed-url";
import { apiError } from "@/lib/api/response";

/** A signed registry reference grants short-lived playback, including authorized operator previews. */
export async function GET(request: Request) {
  const signed = verifySignedMediaUrl(new URL(request.url).searchParams);
  if (!signed.ok) return apiError("PERMISSION_DENIED", "This preview link is invalid or expired.", { status: 403 });
  const prefix = `${signed.workspaceId}/artifact-preview/`;
  const id = signed.key.startsWith(prefix) ? signed.key.slice(prefix.length) : "";
  if (!z.string().uuid().safeParse(id).success) return apiError("PERMISSION_DENIED", "Invalid preview link.", { status: 403 });
  if (signed.contentType !== "video/mp4" && signed.contentType !== "image/webp") {
    return apiError("PERMISSION_DENIED", "Invalid preview type.", { status: 403 });
  }
  const mediaScope = signed.contentType === "video/mp4"
    ? { kind: "SOURCE_PROXY" as const, startMs: BigInt(0), derivationVersion: "analysis-audio-proxy-v2" }
    : { kind: { in: ["TIMELINE_VIEW", "BOUNDARY_STRIP"] as Array<"TIMELINE_VIEW" | "BOUNDARY_STRIP"> },
      derivationVersion: "proxy-contact-sheet-v2" };
  const artifact = await prisma.derivedMediaArtifact.findFirst({ where: { id,
    sourceVideo: { workspaceId: signed.workspaceId }, ...mediaScope, publicationState: "READY", deletedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  } });
  if (!artifact) return apiError("STORAGE_UNAVAILABLE", "This preview is unavailable.", { status: 404 });
  const evidence = z.object({ storageIdentity: z.string(), sha256: z.string(), byteCount: z.string(),
    objectIdentity: z.object({ token: z.string(), byteCount: z.number().int().positive() }) }).safeParse(artifact.publicationEvidence);
  const storage = getStorageProvider();
  const identity = await storage.getObjectIdentity?.(artifact.storageKey);
  if (!evidence.success || evidence.data.storageIdentity !== storage.getStorageIdentity?.() ||
    evidence.data.sha256 !== artifact.sha256 || evidence.data.byteCount !== artifact.byteCount.toString() ||
    !identity || identity.token !== evidence.data.objectIdentity.token ||
    identity.byteCount !== evidence.data.objectIdentity.byteCount || BigInt(identity.byteCount) !== artifact.byteCount) {
    return apiError("STORAGE_UNAVAILABLE", "This preview failed its storage check.", { status: 409 });
  }
  const remaining = Math.min(signed.expiresAt - Math.floor(Date.now() / 1000), artifact.expiresAt
    ? Math.floor((artifact.expiresAt.getTime() - Date.now()) / 1000) : 900);
  if (remaining < 1) return apiError("STORAGE_UNAVAILABLE", "This preview link expired.", { status: 410 });
  if (storage.createSignedReadUrl) return Response.redirect(await storage.createSignedReadUrl(artifact.storageKey, {
    expiresInSeconds: remaining, contentType: signed.contentType, disposition: "inline",
  }), 307);
  const size = identity.byteCount;
  let start = 0, end = size - 1;
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
  }
  const stream = createReadStream(storage.absolutePath(artifact.storageKey), { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200,
    headers: { "Content-Type": signed.contentType, "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
      "Content-Length": String(end - start + 1), ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) } });
}
