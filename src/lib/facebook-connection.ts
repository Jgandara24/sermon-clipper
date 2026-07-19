export type FacebookConnection = {
  pageId: string | null;
  autoPostEnabled: boolean;
};

/**
 * Workspace.settings is a free-form JSON column; this reads the facebookConnection
 * sub-object with safe defaults. `autoPostEnabled` defaults to false — flipping it on is
 * the Tier 3 go-live gate (docs/BUSINESS_OVERVIEW.md), separate from the page being
 * connected at all. See DECISIONS.md "Tier 3 Freeze Lifted" for why this flag exists.
 */
export function parseFacebookConnection(settings: unknown): FacebookConnection {
  const facebookConnection =
    settings && typeof settings === "object" && "facebookConnection" in settings
      ? (settings as { facebookConnection?: unknown }).facebookConnection
      : null;

  const raw = (
    facebookConnection && typeof facebookConnection === "object" ? facebookConnection : {}
  ) as Record<string, unknown>;

  return {
    pageId: typeof raw.pageId === "string" && raw.pageId.trim().length > 0 ? raw.pageId.trim() : null,
    autoPostEnabled: raw.autoPostEnabled === true,
  };
}

/**
 * A workspace is eligible for real Facebook posting only when every one of these holds:
 * a Page ID is configured, the operator has explicitly flipped the go-live flag, and (checked
 * separately, at call time, by the caller) real Meta credentials exist in the environment.
 */
export function isEligibleForAutoPost(connection: FacebookConnection): boolean {
  return connection.autoPostEnabled && connection.pageId !== null;
}
