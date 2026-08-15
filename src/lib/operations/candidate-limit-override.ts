import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { env } from "@/lib/env";
import { recordOperationalEvent } from "@/lib/observability/operational-events";
import {
  PROTECTED_WORKSPACE_SETTINGS_KEY,
  updateWorkspaceSettings,
} from "@/lib/workspace-settings";

const CANDIDATE_LIMIT_OVERRIDE_KEY = "candidateLimitOverride";

export class CandidateLimitOverrideInputError extends Error {}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function updateInternalSettings(
  settings: Record<string, unknown>,
  candidateLimitOverride: number | null,
): Record<string, unknown> {
  const internal = { ...readObject(settings[PROTECTED_WORKSPACE_SETTINGS_KEY]) };
  if (candidateLimitOverride === null) {
    delete internal[CANDIDATE_LIMIT_OVERRIDE_KEY];
  } else {
    internal[CANDIDATE_LIMIT_OVERRIDE_KEY] = candidateLimitOverride;
  }
  return internal;
}

export function readCandidateLimitOverride(settings: unknown): number | undefined {
  const root = readObject(settings);
  const internal = readObject(root[PROTECTED_WORKSPACE_SETTINGS_KEY]);
  const value = internal[CANDIDATE_LIMIT_OVERRIDE_KEY];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function setCandidateLimitOverride(
  client: PrismaClient,
  input: { workspaceId: string; candidateLimitOverride: number | null },
): Promise<void> {
  if (!z.string().uuid().safeParse(input.workspaceId).success) {
    throw new CandidateLimitOverrideInputError("A workspace UUID is required.");
  }

  if (
    input.candidateLimitOverride !== null &&
    (!Number.isInteger(input.candidateLimitOverride) ||
      input.candidateLimitOverride <= 0 ||
      input.candidateLimitOverride > env.CANDIDATE_LIMIT_MAXIMUM)
  ) {
    throw new CandidateLimitOverrideInputError(
      `Candidate limit override must be an integer from 1 through ${env.CANDIDATE_LIMIT_MAXIMUM}.`,
    );
  }

  await updateWorkspaceSettings(
    client,
    input.workspaceId,
    (settings) => ({
      ...settings,
      [PROTECTED_WORKSPACE_SETTINGS_KEY]: updateInternalSettings(
        settings,
        input.candidateLimitOverride,
      ),
    }),
    { allowProtectedSettingsWrite: true },
  );

  const cleared = input.candidateLimitOverride === null;
  // Platform-scoped on purpose: workspace-scoped events feed the church-facing
  // /app/settings/operations page, and the hidden override must never appear on a church
  // surface. The workspace link lives in metadata for staff queries.
  await recordOperationalEvent(client, {
    category: "analysis",
    eventType: cleared ? "candidate_limit_override_cleared" : "candidate_limit_override_set",
    message: cleared
      ? "The internal candidate limit override was cleared."
      : "The internal candidate limit override was set.",
    metadata: {
      workspaceId: input.workspaceId,
      candidateLimitOverride: input.candidateLimitOverride,
    },
  });
}
