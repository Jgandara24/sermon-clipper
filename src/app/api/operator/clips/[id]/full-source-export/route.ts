import { z } from "zod";
import { requireApiPlatformOperator } from "@/lib/api/auth";
import { apiData, apiError } from "@/lib/api/response";
import { requestFullSourceFallback } from "@/lib/exports/full-source-fallback-request";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

/** Operator-only: one explicit, metered original-input export with an open review exception. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiPlatformOperator();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_REQUEST", "A fallback reason of 1 to 500 characters is required.");

  const outcome = await requestFullSourceFallback(prisma, { clipId: id, operatorUserId: auth.user.id, reason: parsed.data.reason });
  if (!outcome.ok) return apiError(outcome.code, outcome.message, { status: outcome.status, retryable: outcome.retryable });
  return apiData({ exportJobId: outcome.exportJobId, fullSourceFallbackId: outcome.fullSourceFallbackId,
    editorialExceptionId: outcome.editorialExceptionId }, { headers: { "Cache-Control": "private, no-store" } });
}
