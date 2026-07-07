import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { apiError } from "@/lib/api/response";
import { verifySignedMediaUrl } from "@/lib/media/signed-url";
import { getStorageProvider } from "@/lib/storage";

function toWebStream(nodeStream: ReturnType<typeof createReadStream>): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

function contentDisposition(disposition: "inline" | "attachment", filename: string | null): string {
  if (!filename) return disposition;
  return `${disposition}; filename="${filename.replace(/"/g, "")}"`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const verified = verifySignedMediaUrl(url.searchParams);

  if (!verified.ok) {
    return apiError(
      verified.reason === "expired" ? "SIGNED_URL_EXPIRED" : "PERMISSION_DENIED",
      verified.reason === "expired" ? "This media link expired. Request a fresh link." : "Invalid media link.",
      { status: verified.reason === "expired" ? 410 : 403, retryable: verified.reason === "expired" },
    );
  }

  const workspaceSegment = `/${verified.workspaceId}/`;
  if (
    !verified.key.startsWith("fixtures/") &&
    !verified.key.startsWith(`${verified.workspaceId}/`) &&
    !verified.key.includes(workspaceSegment)
  ) {
    return apiError("PERMISSION_DENIED", "Invalid media link.", { status: 403 });
  }

  const storage = getStorageProvider();
  const filePath = storage.absolutePath(verified.key);

  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    return apiError("STORAGE_UNAVAILABLE", "Storage hiccup — try again in a minute.", { status: 404 });
  }

  const rangeHeader = request.headers.get("range");
  const baseHeaders = {
    "Content-Type": verified.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": contentDisposition(verified.disposition, verified.filename),
  };

  if (!rangeHeader) {
    return new Response(toWebStream(createReadStream(filePath)), {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Length": String(fileSize),
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
      ...baseHeaders,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    },
  });
}
