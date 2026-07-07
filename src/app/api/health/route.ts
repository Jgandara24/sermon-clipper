import { checkDeploymentReadiness } from "@/lib/deployment/readiness";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await checkDeploymentReadiness(prisma);
  return Response.json(
    {
      service: "sermon-clipper",
      checkedAt: new Date().toISOString(),
      ...readiness,
    },
    { status: readiness.status === "fail" ? 503 : 200 },
  );
}

