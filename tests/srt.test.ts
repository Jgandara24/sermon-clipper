import { describe, expect, it } from "vitest";
import { SrtParseError, parseSrt } from "@/lib/transcription/srt";

const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:04,000
Hello and welcome to today's message.

2
00:00:04,500 --> 00:00:08,200
Let's turn to the book of John.
`;

describe("parseSrt", () => {
  it("parses cues into segments with correct millisecond timing", () => {
    const result = parseSrt(SAMPLE_SRT);

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({
      startMs: 1000,
      endMs: 4000,
      text: "Hello and welcome to today's message.",
    });
    expect(result.segments[1]).toMatchObject({ startMs: 4500, endMs: 8200 });
  });

  it("interpolates word timing within each cue, covering it exactly and contiguously", () => {
    const result = parseSrt(SAMPLE_SRT);
    const words = result.segments[0].words;

    expect(words[0].word).toBe("Hello");
    expect(words[0].startMs).toBe(1000);
    expect(words[words.length - 1].endMs).toBe(4000);
    // contiguous: each word starts where the previous one ended
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i].startMs).toBe(words[i - 1].endMs);
    }
  });

  it("uses the next cue start as the speech boundary for overlapping rolling captions", () => {
    const result = parseSrt(`1
00:00:01,000 --> 00:00:05,000
late eighties early

2
00:00:03,000 --> 00:00:07,000
nineties I prayed
`);

    expect(result.segments[0].endMs).toBe(3000);
    expect(result.segments[0].words.at(-1)?.endMs).toBe(3000);
    expect(result.segments[1].startMs).toBe(3000);
    expect(result.segments[1].words[0].startMs).toBe(3000);
  });

  it("gives longer words proportionally more time than short ones", () => {
    const result = parseSrt("1\n00:00:00,000 --> 00:00:03,000\na extraordinarily\n");
    const [short, long] = result.segments[0].words;

    expect(long.endMs - long.startMs).toBeGreaterThan(short.endMs - short.startMs);
    expect(long.endMs).toBe(3000);
  });

  it("marks interpolated words as full-confidence, non-filler", () => {
    const result = parseSrt(SAMPLE_SRT);
    expect(result.segments[0].words.every((w) => w.confidence === 1 && !w.isFiller)).toBe(true);
  });

  it("throws on an empty file", () => {
    expect(() => parseSrt("   ")).toThrow(SrtParseError);
  });

  it("throws on a malformed timecode", () => {
    expect(() =>
      parseSrt("1\nnot-a-timecode --> 00:00:04,000\nHello\n"),
    ).toThrow(SrtParseError);
  });

  it("throws when a cue's end time is not after its start time", () => {
    expect(() =>
      parseSrt("1\n00:00:04,000 --> 00:00:01,000\nHello\n"),
    ).toThrow(SrtParseError);
  });

  it("throws when no valid cues are found", () => {
    expect(() => parseSrt("just some text\nwith no timecodes\n")).toThrow(SrtParseError);
  });
});
