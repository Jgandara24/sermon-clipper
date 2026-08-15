import { Prisma, type PrismaClient } from "@prisma/client";
import { proxySecretNeedles, redactProxySecrets, PROXY_ARGUMENT_MARKER } from "@/lib/media/proxy-secret";

/**
 * Remediates secrets and internal limit facts already stored in operational events.
 *
 * The remedy is redaction in place, never deletion. These rows are operational history — the
 * failure cause in `processing_job_failed` exists so on-call has something to read — so the goal
 * is to destroy the secret while keeping the event, its timestamp, and its error code. Each
 * remediation mirrors the shape the fixed code now writes:
 *
 *  - proxy secrets in any string value are replaced with the same placeholders the runtime guard
 *    uses;
 *  - the internal candidate ceiling is removed from church-visible metadata;
 *  - the staff override audit event is re-scoped from workspace to platform, with the workspace
 *    id preserved in metadata, exactly as the fixed writer records it.
 *
 * Dry run is the default at every layer. Nothing writes unless `apply` is explicitly true.
 */

const CEILING_KEYS = ["candidateLimit", "candidateLimitOverride"];
const OVERRIDE_EVENT_TYPES = [
  "candidate_limit_override_set",
  "candidate_limit_override_cleared",
];
const UPDATE_CHUNK_SIZE = 100;

type Json = Prisma.JsonValue;

function isJsonObject(value: Json): value is Prisma.JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Replaces every proxy secret in every string leaf. Structure and non-string values survive. */
export function redactJsonProxySecrets(
  value: Json,
  proxyUrl: string | null | undefined,
): { value: Json; changed: boolean } {
  if (typeof value === "string") {
    const redacted = redactProxySecrets(value, proxyUrl);
    return { value: redacted, changed: redacted !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const result = redactJsonProxySecrets(entry, proxyUrl);
      changed = changed || result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (isJsonObject(value)) {
    let changed = false;
    const next: Prisma.JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = redactJsonProxySecrets(entry ?? null, proxyUrl);
      changed = changed || result.changed;
      next[key] = result.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

/** Removes the named keys at any depth. Used to strip the internal ceiling from event metadata. */
export function removeJsonKeys(value: Json, keys: string[]): { value: Json; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const result = removeJsonKeys(entry, keys);
      changed = changed || result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (isJsonObject(value)) {
    let changed = false;
    const next: Prisma.JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (keys.includes(key)) {
        changed = true;
        continue;
      }
      const result = removeJsonKeys(entry ?? null, keys);
      changed = changed || result.changed;
      next[key] = result.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

export type EventRedactionPlan = {
  applied: boolean;
  proxySecretEventCount: number;
  candidateCeilingEventCount: number;
  overrideAuditRescopeCount: number;
  totalEventCount: number;
};

type PendingUpdate = {
  id: string;
  data: Prisma.OperationalEventUpdateInput;
};

async function idsMatchingProxySecrets(
  client: PrismaClient,
  proxyUrl: string | null | undefined,
): Promise<string[]> {
  const needles = [...proxySecretNeedles(proxyUrl), PROXY_ARGUMENT_MARKER];
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM operational_events
    WHERE ${Prisma.join(
      needles.map((needle) => Prisma.sql`metadata::text ILIKE ${`%${needle}%`}`),
      " OR ",
    )}
  `);
  return rows.map((row) => row.id);
}

async function idsExposingCeiling(client: PrismaClient): Promise<string[]> {
  // The OR group needs its own parentheses: Prisma.join does not add them, and AND binds tighter,
  // so an unparenthesized group silently widens the match to every row satisfying the last term.
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM operational_events
    WHERE workspace_id IS NOT NULL
      AND (${Prisma.join(
        CEILING_KEYS.map((key) => Prisma.sql`metadata::text ILIKE ${`%"${key}"%`}`),
        " OR ",
      )})
  `);
  return rows.map((row) => row.id);
}

/**
 * Plans — and, only when `apply` is true, performs — the remediation.
 *
 * Idempotent: a redacted row no longer matches the secret, a stripped key is gone, and a
 * re-scoped audit row is no longer workspace-scoped, so a second run finds nothing to do.
 */
export async function purgeStoredEventExposure(
  client: PrismaClient,
  options: { proxyUrl: string | null | undefined; apply?: boolean },
): Promise<EventRedactionPlan> {
  const apply = options.apply === true;
  const updates: PendingUpdate[] = [];
  let proxySecretEventCount = 0;
  let candidateCeilingEventCount = 0;
  let overrideAuditRescopeCount = 0;

  const [proxyIds, ceilingIds, overrideIds] = await Promise.all([
    idsMatchingProxySecrets(client, options.proxyUrl),
    idsExposingCeiling(client),
    client.operationalEvent
      .findMany({
        where: { workspaceId: { not: null }, eventType: { in: OVERRIDE_EVENT_TYPES } },
        select: { id: true },
      })
      .then((rows) => rows.map((row) => row.id)),
  ]);

  // One fetch and one update per row. A row can qualify for more than one remediation, and
  // separate per-category updates would let the last write silently undo the earlier one.
  const rows = await client.operationalEvent.findMany({
    where: { id: { in: [...new Set([...proxyIds, ...ceilingIds, ...overrideIds])] } },
    select: { id: true, workspaceId: true, eventType: true, metadata: true },
  });

  for (const row of rows) {
    let metadata: Json = row.metadata;
    let changed = false;
    let rescopeToPlatform = false;

    const redacted = redactJsonProxySecrets(metadata, options.proxyUrl);
    if (redacted.changed) {
      metadata = redacted.value;
      changed = true;
      proxySecretEventCount++;
    }

    const isOverrideAudit = OVERRIDE_EVENT_TYPES.includes(row.eventType);
    if (row.workspaceId !== null && !isOverrideAudit) {
      const stripped = removeJsonKeys(metadata, CEILING_KEYS);
      if (stripped.changed) {
        metadata = stripped.value;
        changed = true;
        candidateCeilingEventCount++;
      }
    }

    if (row.workspaceId !== null && isOverrideAudit) {
      // Platform-scoped, with the workspace link preserved in metadata: the exact shape the
      // fixed writer produces, so staff queries keep working and the church feed does not.
      metadata = { ...(isJsonObject(metadata) ? metadata : {}), workspaceId: row.workspaceId };
      rescopeToPlatform = true;
      changed = true;
      overrideAuditRescopeCount++;
    }

    if (changed) {
      updates.push({
        id: row.id,
        data: {
          metadata: metadata as Prisma.InputJsonValue,
          ...(rescopeToPlatform ? { workspace: { disconnect: true } } : {}),
        },
      });
    }
  }

  if (apply) {
    for (let index = 0; index < updates.length; index += UPDATE_CHUNK_SIZE) {
      const chunk = updates.slice(index, index + UPDATE_CHUNK_SIZE);
      await client.$transaction(
        chunk.map((update) =>
          client.operationalEvent.update({ where: { id: update.id }, data: update.data }),
        ),
      );
    }
    if (updates.length > 0) {
      // The remediation is itself auditable. Counts only — never the secret, and platform-scoped
      // so it does not land on a church-facing page.
      await client.operationalEvent.create({
        data: {
          category: "worker",
          eventType: "stored_event_exposure_redacted",
          severity: "warning",
          message: "Stored operational events were redacted to remove leaked facts.",
          metadata: {
            proxySecretEventCount,
            candidateCeilingEventCount,
            overrideAuditRescopeCount,
            totalEventCount: updates.length,
          },
        },
      });
    }
  }

  return {
    applied: apply,
    proxySecretEventCount,
    candidateCeilingEventCount,
    overrideAuditRescopeCount,
    totalEventCount: updates.length,
  };
}
