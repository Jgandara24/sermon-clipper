import { requireApiPlatformOperator } from "@/lib/api/auth";
import { apiData } from "@/lib/api/response";
import { countTranscriptionAlerts } from "@/lib/operations/transcription-alerts";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiPlatformOperator();
  if ("error" in auth) return auth.error;

  return apiData(
    { count: await countTranscriptionAlerts(prisma, auth.user) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
