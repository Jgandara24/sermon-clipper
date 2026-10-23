import { describe, expect, it, vi } from "vitest";
import { wholeSentences } from "@/lib/analysis/boundary-step";
import { findSermonSpan, SERMON_MIN_MS, sermonSpanFromAnswer, sermonSpanPrompt } from "@/lib/analysis/sermon-span";

// Lab sermon 4b (2026-10-19), real lines. Clip 6 came from 7:45, the welcome before a baptism, and
// Jake failed it on test 2. The sermon runs from "take your Bibles" (27:45) to "Would you pray with
// me?" (60:22); the invitation follows.
const SERVICE = [
  { idx: 0, startMs: 266_000, endMs: 268_000, text: "Good morning, Sunny Lane." },
  { idx: 1, startMs: 458_000, endMs: 460_500, text: "We'll see you next week here on The Update." },
  { idx: 2, startMs: 465_672, endMs: 470_500, text: "Well, I know there's a lot of Sooner fans here that are happy 'cause they had victory yesterday." },
  { idx: 3, startMs: 494_400, endMs: 498_100, text: "I want you guys to welcome Nate Reece to our baptistry." },
  { idx: 4, startMs: 1_665_000, endMs: 1_671_000, text: "I want you to take your Bibles and open them in the New Testament to the book of 2 Peter 1." },
  { idx: 5, startMs: 2_133_709, endMs: 2_137_250, text: "So this is what I want you to know concerning the death of a Christian." },
  { idx: 6, startMs: 3_612_000, endMs: 3_621_000, text: "And God's Word never, ever fails." },
  { idx: 7, startMs: 3_622_000, endMs: 3_624_000, text: "Would you pray with me?" },
  { idx: 8, startMs: 3_660_000, endMs: 3_668_000, text: "With every head bowed and every eye closed, man, if you're here today and you've never been saved," },
  { idx: 9, startMs: 3_668_100, endMs: 3_671_000, text: "truly come to that place of total repentance." },
];
const LINES = wholeSentences(SERVICE);

describe("sermonSpanPrompt", () => {
  const prompt = sermonSpanPrompt(LINES);

  it("numbers every sentence of the service with its time", () => {
    expect(prompt).toContain("[0] (4:26) Good morning, Sunny Lane.");
    expect(prompt).toContain("[4] (27:45) I want you to take your Bibles and open them in the New Testament to the book of 2 Peter 1.");
    expect(prompt).toContain("[8] (1:01:00) With every head bowed and every eye closed, man, if you're here today and you've never been saved, truly come");
  });

  it("names every part of the service that is not the sermon", () => {
    for (const part of ["worship", "welcome", "announcements", "offering", "baptism", "closing prayer", "invitation", "altar call"]) {
      expect(prompt).toContain(part);
    }
    expect(prompt).toMatch(/firstLine/);
    expect(prompt).toMatch(/lastLine/);
  });
});

describe("sermonSpanFromAnswer", () => {
  it("turns the first and last line into the sermon's span", () => {
    expect(sermonSpanFromAnswer(LINES, { firstLine: 4, lastLine: 6 })).toEqual({ startMs: 1_665_000, endMs: 3_621_000 });
  });

  it("refuses a reversed, unlisted or fractional answer", () => {
    expect(sermonSpanFromAnswer(LINES, { firstLine: 6, lastLine: 4 })).toBeNull();
    expect(sermonSpanFromAnswer(LINES, { firstLine: 4, lastLine: 99 })).toBeNull();
    expect(sermonSpanFromAnswer(LINES, { firstLine: -1, lastLine: 6 })).toBeNull();
    expect(sermonSpanFromAnswer(LINES, { firstLine: 4.5, lastLine: 6 })).toBeNull();
  });

  it("refuses a sermon shorter than 10 minutes", () => {
    expect(SERMON_MIN_MS).toBe(600_000);
    expect(sermonSpanFromAnswer(LINES, { firstLine: 4, lastLine: 5 })).toBeNull();
  });
});

describe("findSermonSpan", () => {
  it("asks once, with the numbered service, and returns the span and the answer", async () => {
    const ask = vi.fn().mockResolvedValue({ firstLine: 4, lastLine: 6, reason: "from the reading to the closing prayer" });
    const result = await findSermonSpan(SERVICE, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(sermonSpanPrompt(LINES));
    expect(result).toEqual({
      span: { startMs: 1_665_000, endMs: 3_621_000 },
      answer: { firstLine: 4, lastLine: 6, reason: "from the reading to the closing prayer" },
      lines: 9,
    });
  });

  it("returns no span when the answer is refused", async () => {
    const ask = vi.fn().mockResolvedValue({ firstLine: 4, lastLine: 5, reason: "too short" });
    expect((await findSermonSpan(SERVICE, ask)).span).toBeNull();
  });
});
