/**
 * The one human-reference program's key, and the length of the phase.
 *
 * Its own module because both `src/lib/delivery/query.ts` and `src/lib/review/editorial-program.ts`
 * need it and the program module imports the delivery census — importing it the other way would
 * close a cycle.
 */
export const HUMAN_REFERENCE_PROGRAM_KEY = "human-reference";

/**
 * Thirty full days, fixed. Product-owner Decision 2 supersedes Addendum S17's permission to
 * compress the phase on strong early evidence, so this is not a floor a good week can lower.
 */
export const HUMAN_REFERENCE_MINIMUM_DAYS = 30;
