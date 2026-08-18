import { WorkspaceAccessPlan } from "@prisma/client";

export const TRIAL_DAYS = 30;

export type WorkspaceAccessRecord = {
  accessPlan: WorkspaceAccessPlan;
  trialStartedAt: Date;
  trialEndsAt: Date;
  /** Set once the workspace has ever been Paid, and preserved through cancellation. */
  paidAt: Date | null;
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

export const WORKSPACE_ACCESS_STATES = ["trial_active", "trial_expired", "paid", "lapsed"] as const;

export type WorkspaceAccessState = (typeof WORKSPACE_ACCESS_STATES)[number];

export type WorkspaceAccessDecision = {
  allowed: boolean;
  state: WorkspaceAccessState;
  reason: "allowed" | "trial_expired_read_only" | "subscription_ended_read_only";
};

/**
 * The badge the shell shows for a workspace's access state.
 *
 * An exhaustive switch, not a nested ternary: a textual merge can drop one branch of a ternary
 * and still typecheck, which would silently remove a read-only state from the UI. Adding a
 * state without a label here is a compile error.
 */
export function workspaceAccessLabel(state: WorkspaceAccessState): string {
  switch (state) {
    case "paid":
      return "Paid";
    case "trial_active":
      return "Trial active";
    case "lapsed":
      return "Subscription ended · Read-only";
    case "trial_expired":
      return "Trial ended · Read-only";
    default: {
      const unhandled: never = state;
      throw new Error(`Unhandled workspace access state: ${String(unhandled)}`);
    }
  }
}

export function workspaceAccessMessage(decision: WorkspaceAccessDecision): string {
  return decision.state === "lapsed"
    ? "The subscription ended. This workspace is read-only until it changes to Paid."
    : "The trial ended. This workspace is read-only until it changes to Paid.";
}

export class WorkspaceAccessError extends Error {
  constructor(readonly decision: WorkspaceAccessDecision) {
    super(workspaceAccessMessage(decision));
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
  // A workspace that has paid before never returns to its original trial window. Stripe maps a
  // canceled subscription back to accessPlan TRIAL, so without this rule a church that upgraded
  // and canceled inside its first 30 days would keep full free access for the rest of them.
  if (workspace.paidAt !== null) {
    return READ_ONLY_ACTIONS.has(action)
      ? { allowed: true, state: "lapsed", reason: "allowed" }
      : { allowed: false, state: "lapsed", reason: "subscription_ended_read_only" };
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
