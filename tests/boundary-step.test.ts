import { describe, expect, it } from "vitest";
import {
  applyBoundaryChoice,
  boundaryContext,
  boundaryPrompt,
  looksLikeScriptureReadingStart,
} from "@/lib/analysis/boundary-step";

// Real lines from lab sermon 1b around clip 2 (1:11:45–1:12:09), which Jake failed:
// "Ends at the wrong time. should have kept going I think."
const SEGMENTS = [
  { idx: 1172, startMs: 4298000, endMs: 4301500, text: "And by the way, God is a God of grace." },
  { idx: 1173, startMs: 4301724, endMs: 4304304, text: "He's called the, He's called the grace of God." },
  { idx: 1174, startMs: 4304884, endMs: 4307224, text: "God is the God of all grace." },
  { idx: 1175, startMs: 4308644, endMs: 4308684, text: "Amen." },
  { idx: 1176, startMs: 4308684, endMs: 4310104, text: 'You say, "Pastor, what kind of grace is that?"' },
  { idx: 1177, startMs: 4310184, endMs: 4312644, text: "Well, first of all, there's saving grace." },
  { idx: 1178, startMs: 4313604, endMs: 4314484, text: "Saving grace." },
  { idx: 1179, startMs: 4315024, endMs: 4319904, text: 'Ephesians 2:8-9, "For by grace are you saved through faith, and not of yourself.' },
  { idx: 1180, startMs: 4320804, endMs: 4323684, text: 'It\'s the gift of God, not of works, lest any man should boast."' },
  { idx: 1181, startMs: 4324684, endMs: 4328444, text: "You're, you think today that, that you're gonna get to God by your good works." },
  { idx: 1182, startMs: 4329024, endMs: 4330604, text: "See, some of you today, you're, you're just..." },
  { idx: 1183, startMs: 4330644, endMs: 4337864, text: "Grace is a gift. You cannot earn it, and you will never deserve it." },
  { idx: 1184, startMs: 4338000, endMs: 4342000, text: "That is the good news this morning." },
];
const CLIP = { startMs: 4304734, endMs: 4328594 };

describe("looksLikeScriptureReadingStart", () => {
  it.each([
    'The Bible says First Peter chapter five, verse five, "Likewise you younger, submit yourself.',
    "I want you to take your Bibles this morning and open them in the New Testament to the book of First Peter chapter five.",
    'Ephesians 2:8-9, "For by grace are you saved through faith.',
    "Turn with me to Luke chapter 22.",
    "First Peter chapter five, and I'm gonna begin to read in verse five.",
  ])("flags a Scripture reading start: %s", (text) => {
    expect(looksLikeScriptureReadingStart(text)).toBe(true);
  });

  it.each([
    "Well, first of all, there's saving grace.",
    "Jesus washed their feet like a servant.",
    "God can't fill a cup that's already full.",
    "You say, \"Pastor, what kind of grace is that?\"",
  ])("does not flag preaching: %s", (text) => {
    expect(looksLikeScriptureReadingStart(text)).toBe(false);
  });
});

describe("boundaryContext and boundaryPrompt", () => {
  const context = boundaryContext(SEGMENTS, CLIP, 20_000);

  it("takes whole sentences from before and after the clip", () => {
    expect(context.units[0].startMs).toBeLessThanOrEqual(CLIP.startMs - 6_000);
    expect(context.units.at(-1)!.endMs).toBeGreaterThanOrEqual(CLIP.endMs + 9_000);
    expect(context.currentStart).toBe(context.units.findIndex((u) => u.idx === 1174));
    expect(context.currentEnd).toBe(context.units.findIndex((u) => u.idx === 1181));
  });

  const prompt = boundaryPrompt(context);

  it("states the founder's start and end rules", () => {
    expect(prompt).toMatch(/where the thought starts/i);
    expect(prompt).toMatch(/where the point lands/i);
    expect(prompt).toMatch(/never start on the scripture reading/i);
    expect(prompt).toMatch(/15 and 90 seconds/);
  });

  it("numbers every unit and marks the current clip", () => {
    expect(prompt).toContain("[0] ");
    expect(prompt).toContain(`[${context.units.length - 1}] `);
    expect(prompt).toMatch(/current clip.*\[\d+\].*\[\d+\]/i);
  });
});

describe("applyBoundaryChoice", () => {
  const context = boundaryContext(SEGMENTS, CLIP, 20_000);
  const at = (idx: number) => context.units.findIndex((u) => u.idx === idx);

  it("moves the clip to the chosen sentences", () => {
    const result = applyBoundaryChoice(context, { startUnit: at(1176), endUnit: at(1184) });
    expect(result).toEqual({ startMs: 4308684, endMs: 4342000, adjustedForScripture: false });
  });

  it("steps past a Scripture reading at the start, through the end of the quoted passage", () => {
    // 1179 opens the quote of Ephesians 2:8-9 and 1180 closes it; the preacher resumes at 1181.
    const result = applyBoundaryChoice(context, { startUnit: at(1179), endUnit: at(1184) });
    expect(result).toEqual({ startMs: 4324684, endMs: 4342000, adjustedForScripture: true });
  });

  it("refuses a choice that is too short, too long, reversed or out of range", () => {
    expect(applyBoundaryChoice(context, { startUnit: at(1178), endUnit: at(1178) })).toBeNull();
    expect(applyBoundaryChoice(context, { startUnit: at(1181), endUnit: at(1176) })).toBeNull();
    expect(applyBoundaryChoice(context, { startUnit: -1, endUnit: at(1180) })).toBeNull();
    expect(applyBoundaryChoice(context, { startUnit: 0, endUnit: 999 })).toBeNull();
    const long = boundaryContext(
      Array.from({ length: 60 }, (_, i) => ({ idx: i, startMs: i * 3_000, endMs: i * 3_000 + 2_500, text: "Point." })),
      { startMs: 60_000, endMs: 90_000 },
      90_000,
    );
    expect(applyBoundaryChoice(long, { startUnit: 0, endUnit: 59 })).toBeNull();
  });
});
