import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { MAX_UPLOAD_BYTES } from "@/lib/limits";
import { createSignedUploadUrl, DEFAULT_UPLOAD_URL_TTL_SECONDS } from "@/lib/media/signed-url";

const bodySchema = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  type: z.string().trim().min(1).max(255).optional(),
});

export async function POST(request: Request) {
  const auth = await requireApiWorkspace("IMPORT_MEDIA");
  if ("error" in auth) return auth.error;
  const { workspace } = auth;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return apiError("INVALID_FILE_TYPE", "That file isn't a video we can read.");
  }

  if (parsed.data.size > MAX_UPLOAD_BYTES) {
    return apiError("FILE_TOO_LARGE", "Videos up to 5 GB for now.", { status: 413 });
  }

  if (workspace.minuteBalance.lessThanOrEqualTo(0)) {
    return apiError(
      "INSUFFICIENT_MINUTES",
      `This needs minutes to process; you have ${workspace.minuteBalance.toString()}.`,
      { status: 402 },
    );
  }

  const uploadId = randomUUID();

  return apiData({
    uploadId,
    uploadUrl: createSignedUploadUrl({ uploadId, workspaceId: workspace.id }),
    method: "PUT",
    maxBytes: MAX_UPLOAD_BYTES,
    expiresInSeconds: DEFAULT_UPLOAD_URL_TTL_SECONDS,
  });
}
