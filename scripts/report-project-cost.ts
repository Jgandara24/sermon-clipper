#!/usr/bin/env tsx
import { PrismaClient } from "@prisma/client";
import { getProjectCostReport, rollupProcessingCosts } from "@/lib/cost/rollup";

function readProjectId(args: string[]): string {
  const index = args.indexOf("--project-id");
  const projectId = index >= 0 ? args[index + 1] : undefined;
  if (!projectId) {
    throw new Error("Usage: npm run report:project-cost -- --project-id <uuid>");
  }
  return projectId;
}

async function main() {
  const projectId = readProjectId(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { workspaceId: true, createdAt: true },
    });
    await rollupProcessingCosts(prisma, {
      workspaceId: project.workspaceId,
      from: project.createdAt,
      to: new Date(Date.now() + 1),
    });
    console.log(JSON.stringify(await getProjectCostReport(prisma, projectId), null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
