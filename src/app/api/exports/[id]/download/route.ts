import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiError } from "@/lib/api/response";
import { prisma } from "@/lib/prisma";
import { assertWorkspaceScope } from "@/lib/project-service";
import { getStorageProvider } from "@/lib/storage";

function toWebStream(nodeStream: ReturnType<typeof createReadStream>): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Downloads a finished export (guide §15 step 4, §20 DOWNLOAD_LINK_EXPIRED). The "signed link"
 * is a session-authenticated route rather than a cryptographically signed URL — see
 * DECISIONS.md for why that's an appropriate simplification for this local-disk dev stand-in.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiWorkspace();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const job = await prisma.exportJob.findUnique({ where: { id }, include: { outputFile: true } });
  if (!job) {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 404 });
  }
  try {
    assertWorkspaceScope(job.workspaceId, auth.workspace.id, "export job");
  } catch {
    return apiError("PERMISSION_DENIED", "You don't have access to that workspace.", { status: 403 });
  }

  if (!job.outputFile) {
    return apiError("RENDER_FAILED", "Export failed on our side — your clip is safe.", { status: 404 });
  }
  if (job.outputFile.downloadExpiresAt <= new Date()) {
    return apiError("DOWNLOAD_LINK_EXPIRED", "Link expired — here's a fresh one.", {
      status: 410,
      retryable: true,
    });
  }

  const storage = getStorageProvider();
  const filePath = storage.absolutePath(job.outputFile.storageKey);

  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    return apiError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.", { status: 404 });
  }

  return new Response(toWebStream(createReadStream(filePath)), {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(fileSize),
      "Content-Disposition": `attachment; filename="${job.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
