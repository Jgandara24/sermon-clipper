import { z } from "zod";
import type { SermonsPerWeek } from "@/lib/church-profile";

/**
 * The one service-count rule, in one place.
 *
 * Three services a week is out of scope for this product phase (Rev2 §9), and the onboarding and
 * settings pages both say so with a disabled option. A disabled `<option>` is courtesy, not a
 * control: the value can be forged, so the rule that actually holds is this schema — used by both
 * the onboarding action and the profile action, so the two cannot drift apart or drift from the
 * `SermonsPerWeek` type.
 *
 * When three services become supported, this constant, the type, and both selects move together.
 */

export const SUPPORTED_SERMONS_PER_WEEK: readonly SermonsPerWeek[] = [1, 2];

/** The option shown but not selectable. Named so a test can assert the UI and the rule agree. */
export const COMING_LATER_SERMONS_PER_WEEK = 3;

export const sermonsPerWeekSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(2, "Three services a week are not supported yet.");
