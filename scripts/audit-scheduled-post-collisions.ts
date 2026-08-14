#!/usr/bin/env tsx
import { auditScheduledPostCollisions } from "../src/lib/audits/preflight";
import { prisma } from "../src/lib/prisma";

async function main() {
  const result = await auditScheduledPostCollisions(prisma);
  console.log(JSON.stringify(result, null, 2));
  if (result.duplicateDateCount > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
