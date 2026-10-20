import { z } from "zod";
import { clock, wholeSentences, type BoundaryUnit } from "./boundary-step";

/**
 * Phase 1 lab sermon span (fix J, docs/FOUNDER_BRIEF.md, quality test 2: preaching only). Stage A
 * reads each excerpt alone, so a welcome that sounds like preaching passes: lab sermon 4b clip 6
 * (2026-10-19) came from 7:45, twenty minutes before the sermon, and led into a baptism. One model
 * call reads the whole service and returns where the sermon starts and ends; the lab steps then keep
 * only clips inside it. Spans found by hand put all 8 clips Jake failed on test 2 outside and all
 * 88 other clips he marked inside.
 */

// A Wednesday sermon runs 44 minutes; anything under 10 is a misread, and the lab keeps every clip.
export const SERMON_MIN_MS = 10 * 60_000;

export const SermonSpanSchema = z.object({
  firstLine: z.number().int(),
  lastLine: z.number().int(),
  reason: z.string(),
});
export type SermonSpanAnswer = z.infer<typeof SermonSpanSchema>;
export type SermonSpan = { startMs: number; endMs: number };

export function sermonSpanPrompt(lines: BoundaryUnit[]): string {
  return (
    "Below is the transcript of a whole church service recording, one numbered sentence per line with its time. " +
    "Find the sermon: the part where the preacher preaches his message.\n\n" +
    "- The sermon starts where the preacher begins his message: often when he asks people to open their Bibles, " +
    "reads the text, or starts the introduction that leads into it. Before it come the worship singing, the " +
    "welcome, the announcements, the offering, any baptism, special music, and any prayer for the service.\n" +
    "- The sermon ends on the last line of his message, before the closing prayer, the invitation or altar call " +
    "(\"every head bowed\", \"come to this altar\", raising hands to respond), or a closing song. The invitation " +
    "starts where he first calls people to come to the altar or come forward, even when he keeps preaching while " +
    "he calls them.\n" +
    "- A story, a joke, or a direct word to the listener inside the message is still the sermon.\n\n" +
    "Return firstLine (the first line of the sermon), lastLine (the last line of the sermon), and a one-sentence reason.\n\n" +
    lines.map((line, i) => `[${i}] (${clock(line.startMs)}) ${line.text}`).join("\n")
  );
}

/** The sermon's span on the source clock, or null when the answer is not a usable span. */
export function sermonSpanFromAnswer(lines: BoundaryUnit[], answer: Pick<SermonSpanAnswer, "firstLine" | "lastLine">): SermonSpan | null {
  const { firstLine, lastLine } = answer;
  if (!Number.isInteger(firstLine) || !Number.isInteger(lastLine)) return null;
  if (firstLine < 0 || lastLine >= lines.length || firstLine > lastLine) return null;
  const span = { startMs: lines[firstLine].startMs, endMs: lines[lastLine].endMs };
  return span.endMs - span.startMs >= SERMON_MIN_MS ? span : null;
}

/** One model call on the whole service. A null span means the lab keeps every clip. */
export async function findSermonSpan(
  segments: BoundaryUnit[],
  ask: (prompt: string) => Promise<SermonSpanAnswer>,
): Promise<{ span: SermonSpan | null; answer: SermonSpanAnswer; lines: number }> {
  const lines = wholeSentences(segments);
  const answer = await ask(sermonSpanPrompt(lines));
  return { span: sermonSpanFromAnswer(lines, answer), answer, lines: lines.length };
}
