import { z } from "zod";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { prisma } from "@/lib/prisma";
import { getStorageProvider } from "@/lib/storage";
import { abortMultipartUpload, completeMultipartUpload, initiateMultipartUpload, listMultipartUploadParts, signMultipartUploadPart } from "@/lib/uploads/multipart-session";
import { multipartErrorResponse } from "@/lib/uploads/multipart-response";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("sign"), partNumber: z.number().int().min(1).max(10_000) }).strict(),
  z.object({ action: z.literal("complete") }).strict(),
  z.object({ action: z.literal("abort") }).strict(),
]);

export async function POST(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const auth = await requireApiWorkspace("IMPORT_MEDIA");
  if ("error" in auth) return auth.error!;
  const { uploadId } = await params;
  const id = z.string().uuid().safeParse(uploadId);
  const body = actionSchema.safeParse(await request.json().catch(() => null));
  if (!id.success || !body.success) return apiError("INVALID_UPLOAD_REQUEST", "This upload request is invalid.");
  const target = { id: id.data, workspaceId: auth.workspace.id };
  try {
    const storage = getStorageProvider();
    switch (body.data.action) {
      case "start": {
        const row = await initiateMultipartUpload(prisma, storage, target);
        return apiData({ uploadId: row.id, state: row.state, partBytes: Number(row.partBytes), totalBytes: Number(row.totalBytes) });
      }
      case "list":
        return apiData(await listMultipartUploadParts(prisma, storage, target), { headers: { "Cache-Control": "no-store" } });
      case "sign": {
        const uploadUrl = await signMultipartUploadPart(prisma, storage, { ...target, partNumber: body.data.partNumber, expiresInSeconds: 900 });
        return apiData({ uploadUrl, method: "PUT" }, { headers: { "Cache-Control": "no-store" } });
      }
      case "complete": {
        const source = await completeMultipartUpload(prisma, storage, target);
        return apiData({ sourceVideoId: source.id });
      }
      case "abort":
        await abortMultipartUpload(prisma, storage, target);
        return apiData({ uploadId: id.data, state: "ABORTED" });
    }
  } catch (error) { return multipartErrorResponse(error); }
}
