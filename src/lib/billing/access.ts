import { WorkspaceAccessPlan } from "@prisma/client";

export const TRIAL_DAYS = 30;

export type WorkspaceAccessRecord = {
  accessPlan: WorkspaceAccessPlan;
  trialStartedAt: Date;
  trialEndsAt: Date;
};

export type WorkspaceAction =
  | "read"
  | "manage_billing"
  | "manage_settings"
  | "import_media"
  | "start_processing"
  | "export_clip"
  | "schedule_post"
  | "publish_post";

export type WorkspaceAccessDecision = {
  allowed: boolean;
  state: "trial_active" | "trial_expired" | "paid";
  reason: "allowed" | "trial_expired_read_only";
};

export class WorkspaceAccessError extends Error {
  constructor(readonly decision: WorkspaceAccessDecision) {
    super("The trial ended. This workspace is read-only until it changes to Paid.");
  }
}

const READ_ONLY_ACTIONS = new Set<WorkspaceAction>([
  "read",
  "manage_billing",
  "manage_settings",
]);

/** One access decision for all product actions. Trial and Paid have the same capabilities. */
export function decideWorkspaceAccess(
  workspace: WorkspaceAccessRecord,
  action: WorkspaceAction,
  at = new Date(),
): WorkspaceAccessDecision {
  if (workspace.accessPlan === WorkspaceAccessPlan.PAID) {
    return { allowed: true, state: "paid", reason: "allowed" };
  }
  if (at < workspace.trialEndsAt) {
    return { allowed: true, state: "trial_active", reason: "allowed" };
  }
  if (READ_ONLY_ACTIONS.has(action)) {
    return { allowed: true, state: "trial_expired", reason: "allowed" };
  }
  return {
    allowed: false,
    state: "trial_expired",
    reason: "trial_expired_read_only",
  };
}

export function assertWorkspaceAccess(
  workspace: WorkspaceAccessRecord,
  action: WorkspaceAction,
  at = new Date(),
): void {
  const decision = decideWorkspaceAccess(workspace, action, at);
  if (!decision.allowed) throw new WorkspaceAccessError(decision);
}

export function trialDates(startedAt: Date): { trialStartedAt: Date; trialEndsAt: Date } {
  return {
    trialStartedAt: startedAt,
    trialEndsAt: new Date(startedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
  };
}
