/**
 * Workspace-level delivery switches.
 *
 * `Workspace.settings` is a free-form JSON column, so every field here defaults to the safe
 * value when it is absent or the wrong shape. Both switches default in the direction that stops
 * a post rather than permits one: a workspace that has never been configured cannot publish by
 * omission.
 */

export type DeliverySettings = {
  /**
   * Whether a church must approve each clip before it can reach an audience. Optional by design
   * (Decision D): editorial ACCEPT is always required, customer approval only when this is on.
   */
  customerApprovalRequired: boolean;
  /**
   * An operator hold over one workspace. Distinct from the global kill switch: this pauses one
   * church during a pilot without touching anyone else, and nothing clears it automatically.
   */
  pilotHold: boolean;
};

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  customerApprovalRequired: false,
  pilotHold: false,
};

export function parseDeliverySettings(settings: unknown): DeliverySettings {
  const delivery =
    settings && typeof settings === "object" && "delivery" in settings
      ? (settings as { delivery?: unknown }).delivery
      : null;

  const raw = (delivery && typeof delivery === "object" ? delivery : {}) as Record<string, unknown>;

  return {
    // Strict `=== true`: a string "false", a 0, or a typo must not read as enabled.
    customerApprovalRequired: raw.customerApprovalRequired === true,
    pilotHold: raw.pilotHold === true,
  };
}
