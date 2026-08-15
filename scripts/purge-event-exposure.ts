#!/usr/bin/env tsx
/**
 * Removes leaked facts from stored operational events. DRY RUN BY DEFAULT.
 *
 * Usage:
 *   DATABASE_URL=... YTDLP_PROXY_URL=... npm run purge:event-exposure            # plan only
 *   DATABASE_URL=... YTDLP_PROXY_URL=... npm run purge:event-exposure -- --apply # writes
 *
 * Redacts in place; it never deletes an event. Proxy secrets in any string value are replaced,
 * the internal candidate ceiling is stripped from church-visible metadata, and the staff override
 * audit row is re-scoped from workspace to platform. The event, its timestamp, and its error code
 * all survive, so operational history and the audit trail stay intact.
 *
 * Rotate the proxy credential FIRST. Redaction removes the copy in this database; it cannot
 * un-expose a credential that a church admin may already have read.
 *
 * As with the audit, the proxy URL is read from the environment only: a credential passed in argv
 * reaches shell history, `ps`, and the command line npm echoes before running.
 */
import { auditEventExposure } from "../src/lib/audits/event-exposure";
import { purgeStoredEventExposure } from "../src/lib/audits/event-redaction";
import { ytDlpProxyUrl } from "../src/lib/env";
import { prisma } from "../src/lib/prisma";

async function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const proxyUrl = ytDlpProxyUrl();

  const before = await auditEventExposure(prisma, proxyUrl);
  const plan = await purgeStoredEventExposure(prisma, { proxyUrl, apply });

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry_run",
        before: {
          proxyMatchedEventCount: before.proxyExposure.matchedEventCount,
          proxyCredentialEventCount: before.proxyExposure.credentialEventCount,
          churchVisibleProxyEventCount: before.proxyExposure.churchVisibleEventCount,
          churchVisibleCeilingEventCount: before.candidateLimitExposure.churchVisibleEventCount,
        },
        plan,
      },
      null,
      2,
    ),
  );

  console.error("");
  if (!proxyUrl) {
    console.error(
      "No YTDLP_PROXY_URL was set. Proxy secrets cannot be matched, so this run only handles the candidate-ceiling rows.",
    );
  }
  if (!apply) {
    console.error(
      `DRY RUN. Nothing was changed. ${plan.totalEventCount} event(s) would be redacted. Re-run with --apply to write.`,
    );
    return;
  }

  const after = await auditEventExposure(prisma, proxyUrl);
  console.error(`APPLIED. ${plan.totalEventCount} event(s) were redacted.`);
  console.error(
    `Remaining after redaction: ${after.proxyExposure.credentialEventCount} credential event(s), ` +
      `${after.candidateLimitExposure.churchVisibleEventCount} church-visible ceiling event(s).`,
  );
  if (after.proxyExposure.credentialEventCount > 0) {
    console.error("A credential still remains. Investigate before considering this closed.");
    process.exitCode = 1;
  }
  console.error("Rotate the proxy credential if you have not already. Redaction is not rotation.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
