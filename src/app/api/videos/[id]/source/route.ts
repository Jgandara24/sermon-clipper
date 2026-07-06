import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiError } from "@/lib/api/response";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";
import { getStorageProvider } from "@/lib/storage";

function contentTypeForFilename(filename: string | null): string {
  if (filename?.toLowerCase().endsWith(".mov")) return "video/quicktime";
  return "video/mp4";
}

function toWebStream(nodeStream: ReturnType<typeof createReadStream>): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

/** Streams the original source video with HTTP Range support, for the editor's preview player. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const { id } = await params;
  const sourceVideo = await prisma.sourceVideo.findUnique({ where: { id } });
  if (!sourceVideo?.storageKey) {
    return apiError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.", {
      status: 404,
    });
  }
  try {
    assertWorkspaceScope(sourceVideo.workspaceId, workspace.id, "source video");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", {
      status: 403,
    });
  }

  const storage = getStorageProvider();
  const filePath = storage.absolutePath(sourceVideo.storageKey);

  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    return apiError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.", {
      status: 404,
    });
  }

  const contentType = contentTypeForFilename(sourceVideo.filename);
  const rangeHeader = request.headers.get("range");

  if (!rangeHeader) {
    return new Response(toWebStream(createReadStream(filePath)), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : fileSize - 1;

  if (!match || Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${fileSize}` },
    });
  }

  const chunkSize = end - start + 1;

  return new Response(toWebStream(createReadStream(filePath, { start, end })), {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
