#!/usr/bin/env tsx
/**
 * READ-ONLY. Censuses operational events that already contain the yt-dlp proxy secret or the
 * internal candidate ceiling. Runs SELECT statements only — it never rotates, purges, or edits.
 *
 * Usage:
 *   DATABASE_URL=... YTDLP_PROXY_URL=... npm run audit:event-exposure
 *
 * The proxy URL is read from the environment only, and deliberately has no command-line flag: a
 * credential passed as an argument is visible in shell history, in `ps`, and in the command line
 * npm echoes before it runs. Without the variable the audit still finds a bare `--proxy` marker,
 * but it cannot prove whether the credential leaked with it. Samples are redacted before printing.
 */
import { auditEventExposure } from "../src/lib/audits/event-exposure";
import { ytDlpProxyUrl } from "../src/lib/env";
import { prisma } from "../src/lib/prisma";

async function main() {
  const proxyUrl = ytDlpProxyUrl();
  const audit = await auditEventExposure(prisma, proxyUrl);
  console.log(JSON.stringify(audit, null, 2));

  const { proxyExposure: proxy, candidateLimitExposure: limits } = audit;
  console.error("");
  console.error("READ-ONLY audit. Nothing was changed.");
  if (!proxy.configuredProxyUrlPresent) {
    console.error(
      "No proxy URL was configured for this run. Set YTDLP_PROXY_URL to classify credential exposure.",
    );
  }
  if (proxy.credentialEventCount > 0) {
    console.error(
      `ACTION: ${proxy.credentialEventCount} event(s) contain the proxy credential. Rotate it, then purge or redact those rows.`,
    );
  } else if (proxy.matchedEventCount > 0) {
    console.error(
      `REVIEW: ${proxy.matchedEventCount} event(s) contain a proxy URL or command-line marker without a matched credential.`,
    );
  }
  if (limits.churchVisibleEventCount > 0) {
    console.error(
      `REVIEW: ${limits.churchVisibleEventCount} workspace-scoped event(s) expose the internal candidate ceiling or override.`,
    );
  }
  if (!audit.exposureFound) console.error("No stored exposure was found.");
  if (audit.exposureFound) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
