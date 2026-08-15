import { Prisma, type PrismaClient } from "@prisma/client";
import {
  classifyProxyExposure,
  proxySecretNeedles,
  redactProxySecrets,
  PROXY_ARGUMENT_MARKER,
} from "@/lib/media/proxy-secret";

/**
 * Read-only census of secrets and internal limit facts already stored in operational events.
 *
 * Two P0 defects wrote facts that the church-facing /app/settings/operations page renders to
 * OWNER and ADMIN roles: the yt-dlp proxy URL reached job-failure metadata through the execFile
 * error message, and the resolved candidate ceiling reached processing_job_succeeded metadata.
 * Both are fixed forward, but a code fix cannot retract rows that already exist. This module
 * counts them so an operator can decide whether to rotate the proxy credential and purge rows.
 *
 * Every statement here is a SELECT. The audit never writes, updates, or deletes.
 */

const SAMPLE_LIMIT = 5;
const EXCERPT_LENGTH = 200;
const OVERRIDE_EVENT_TYPES = [
  "candidate_limit_override_set",
  "candidate_limit_override_cleared",
];

type ExposureRow = {
  id: string;
  event_type: string;
  workspace_id: string | null;
  created_at: Date;
  metadata_text: string;
};

export type ProxyExposureReport = {
  configuredProxyUrlPresent: boolean;
  matchedEventCount: number;
  credentialEventCount: number;
  churchVisibleEventCount: number;
  affectedWorkspaceCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  byEventType: Array<{ eventType: string; count: number }>;
  samples: Array<{
    operationalEventId: string;
    eventType: string;
    workspaceId: string | null;
    createdAt: string;
    severity: "credential" | "location" | "marker" | "none";
    redactedExcerpt: string;
  }>;
};

export type CandidateLimitExposureReport = {
  churchVisibleEventCount: number;
  affectedWorkspaceCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  byEventType: Array<{ eventType: string; count: number }>;
};

export type EventExposureAudit = {
  scannedEventCount: number;
  proxyExposure: ProxyExposureReport;
  candidateLimitExposure: CandidateLimitExposureReport;
  exposureFound: boolean;
};

function contains(needle: string): Prisma.Sql {
  return Prisma.sql`metadata::text ILIKE ${`%${needle}%`}`;
}

function summarize(rows: Array<{ event_type: string; workspace_id: string | null; created_at: Date }>) {
  const byEventType = new Map<string, number>();
  const workspaces = new Set<string>();
  let firstSeenAt: Date | null = null;
  let lastSeenAt: Date | null = null;
  for (const row of rows) {
    byEventType.set(row.event_type, (byEventType.get(row.event_type) ?? 0) + 1);
    if (row.workspace_id) workspaces.add(row.workspace_id);
    if (!firstSeenAt || row.created_at < firstSeenAt) firstSeenAt = row.created_at;
    if (!lastSeenAt || row.created_at > lastSeenAt) lastSeenAt = row.created_at;
  }
  return {
    byEventType: [...byEventType.entries()]
      .map(([eventType, count]) => ({ eventType, count }))
      .sort((a, b) => b.count - a.count || a.eventType.localeCompare(b.eventType)),
    affectedWorkspaceCount: workspaces.size,
    firstSeenAt: firstSeenAt?.toISOString() ?? null,
    lastSeenAt: lastSeenAt?.toISOString() ?? null,
  };
}

/**
 * Counts stored events that contain the proxy URL, any part of its credential, or a bare
 * `--proxy` command-line marker. Pass the proxy URL that production actually uses; without it
 * the audit can still find the marker, but it cannot prove whether a credential came with it.
 */
export async function auditProxySecretExposure(
  client: PrismaClient,
  proxyUrl: string | null | undefined,
): Promise<ProxyExposureReport> {
  const needles = [...proxySecretNeedles(proxyUrl), PROXY_ARGUMENT_MARKER];
  const rows = await client.$queryRaw<ExposureRow[]>(Prisma.sql`
    SELECT id, event_type, workspace_id, created_at, metadata::text AS metadata_text
    FROM operational_events
    WHERE ${Prisma.join(needles.map(contains), " OR ")}
    ORDER BY created_at ASC
  `);

  const summary = summarize(rows);
  const classified = rows.map((row) => ({
    row,
    severity: classifyProxyExposure(row.metadata_text, proxyUrl),
  }));

  return {
    configuredProxyUrlPresent: Boolean(proxyUrl?.trim()),
    matchedEventCount: rows.length,
    credentialEventCount: classified.filter((entry) => entry.severity === "credential").length,
    churchVisibleEventCount: rows.filter((row) => row.workspace_id !== null).length,
    ...summary,
    // Samples are redacted before they reach a terminal, a log, or a paste buffer.
    samples: classified.slice(0, SAMPLE_LIMIT).map((entry) => ({
      operationalEventId: entry.row.id,
      eventType: entry.row.event_type,
      workspaceId: entry.row.workspace_id,
      createdAt: entry.row.created_at.toISOString(),
      severity: entry.severity,
      redactedExcerpt: redactProxySecrets(
        entry.row.metadata_text.slice(0, EXCERPT_LENGTH),
        proxyUrl,
      ),
    })),
  };
}

/**
 * Counts workspace-scoped events that carry the internal candidate ceiling or the hidden
 * per-church override. Only workspace-scoped rows appear on the church-facing operations page,
 * so platform-scoped audit rows are correctly excluded.
 */
export async function auditCandidateLimitExposure(
  client: PrismaClient,
): Promise<CandidateLimitExposureReport> {
  const rows = await client.$queryRaw<
    Array<{ event_type: string; workspace_id: string | null; created_at: Date }>
  >(Prisma.sql`
    SELECT event_type, workspace_id, created_at
    FROM operational_events
    WHERE workspace_id IS NOT NULL
      AND (
        ${contains('"candidateLimit"')}
        OR ${contains('"candidateLimitOverride"')}
        OR event_type IN (${Prisma.join(OVERRIDE_EVENT_TYPES)})
      )
    ORDER BY created_at ASC
  `);

  return { churchVisibleEventCount: rows.length, ...summarize(rows) };
}

/** Runs both censuses. Read-only; safe against production. */
export async function auditEventExposure(
  client: PrismaClient,
  proxyUrl: string | null | undefined,
): Promise<EventExposureAudit> {
  const [scanned, proxyExposure, candidateLimitExposure] = await Promise.all([
    client.operationalEvent.count(),
    auditProxySecretExposure(client, proxyUrl),
    auditCandidateLimitExposure(client),
  ]);

  return {
    scannedEventCount: scanned,
    proxyExposure,
    candidateLimitExposure,
    exposureFound:
      proxyExposure.matchedEventCount > 0 || candidateLimitExposure.churchVisibleEventCount > 0,
  };
}
