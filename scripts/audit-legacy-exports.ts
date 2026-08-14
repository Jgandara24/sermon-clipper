#!/usr/bin/env tsx
import { auditLegacyExports } from "../src/lib/audits/preflight";
import { prisma } from "../src/lib/prisma";

async function main() {
  console.log(JSON.stringify(await auditLegacyExports(prisma), null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
