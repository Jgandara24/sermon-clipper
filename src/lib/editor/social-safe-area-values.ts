/**
 * The numbers, and nothing else.
 *
 * They live apart from the meanings in `social-safe-area.ts` for one reason: it makes "every
 * consumer reads the datum" a thing a test can prove rather than assert. A test replaces this
 * module, and every consumer that derives its geometry moves; one that kept a copy would not.
 *
 * Versioned, because moving any of these moves every clip rendered afterwards.
 */
export const SAFE_AREA_VALUES = {
  version: 1,

  /**
   * What each platform's own chrome covers, as fractions of the frame: the caption and action rail
   * along the bottom, the account and sound line along the top.
   */
  chrome: { top: 0.06, right: 0.06, bottom: 0.12, left: 0.06 },

  /**
   * How far below the top chrome an anchored edge sits. This is the 2 percent the burn-in has
   * always put between the top band and a top-anchored caption, recorded rather than discovered.
   */
  topPadding: 0.02,

  /**
   * The caption's own left and right margin in the exported file, in pixels of the output frame.
   *
   * Known not to agree with `chrome.left`: at 1080 wide this is 3.7 percent against the guide's 6,
   * so a full-width caption reaches about 25px into the side band the guide draws. Recorded as it
   * is because changing it re-renders every stored clip, and that is the product owner's call.
   */
  captionMarginHPx: 40,

  /** Where the brand template's lower third sits above the bottom of the frame. */
  lowerThirdBottom: 0.22,
} as const;
