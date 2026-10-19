import { describe, expect, it, vi } from "vitest";
import {
  applyBoundaryChoice,
  BOUNDARY_MAX_MS,
  boundaryRefusal,
  chooseBoundary,
  endsOnQuotationStart,
  boundaryContext,
  boundaryPrompt,
  looksLikeScriptureReadingStart,
  wholeSentences,
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
    expect(prompt).toMatch(/15 and 59 seconds/);
    expect(prompt).toMatch(/under 60 seconds/i);
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
    expect(result).toEqual({ startMs: 4308684, endMs: 4342000, adjustedForScripture: false, adjustedEnd: false });
  });

  it("steps past a Scripture reading at the start, through the end of the quoted passage", () => {
    // 1179 opens the quote of Ephesians 2:8-9 and 1180 closes it; the preacher resumes at 1181.
    const result = applyBoundaryChoice(context, { startUnit: at(1179), endUnit: at(1184) });
    expect(result).toEqual({ startMs: 4324684, endMs: 4342000, adjustedForScripture: true, adjustedEnd: false });
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

  it("refuses any clip of 60 seconds or more (Jake, 2026-10-18: keep clips under 60 seconds)", () => {
    const units = Array.from({ length: 40 }, (_, i) => ({ idx: i, startMs: i * 3_000, endMs: i * 3_000 + 2_900, text: "Point." }));
    const context = boundaryContext(units, { startMs: 30_000, endMs: 60_000 }, 90_000);
    expect(applyBoundaryChoice(context, { startUnit: 0, endUnit: 19 })).toEqual({ startMs: 0, endMs: 59_900, adjustedForScripture: false, adjustedEnd: false });
    expect(applyBoundaryChoice(context, { startUnit: 0, endUnit: 20 })).toBeNull();
    expect(BOUNDARY_MAX_MS).toBeLessThan(60_000);
  });
});

// Lab sermon 1c clip 5 (57:35), real lines. Jake: "Should have ended with ... Secondly, you need
// to resist him." The model ended two lines later, on the lead-in to a verse.
const CLIP5 = [
  { idx: 898, startMs: 3455184, endMs: 3456200, text: "Now, think about this." },
  { idx: 899, startMs: 3456300, endMs: 3461000, text: "Peter in verse seven has told them that they're to be carefree." },
  { idx: 900, startMs: 3462000, endMs: 3466000, text: "But then in verse eight, he reminds them not to be careless." },
  { idx: 911, startMs: 3505000, endMs: 3508000, text: "First of all, very first thing you need to do is you need to recognize him." },
  { idx: 912, startMs: 3509000, endMs: 3510500, text: "You need to recognize the devil." },
  { idx: 913, startMs: 3511000, endMs: 3513400, text: "Secondly, you need to resist him." },
  { idx: 914, startMs: 3515000, endMs: 3518400, text: "Now, fellas, you got, you gotta recognize him, 'cause, 'cause notice what he says there." },
  { idx: 915, startMs: 3519000, endMs: 3522400, text: 'He says, "Your adversary the devil".' },
];

describe("endsOnQuotationStart", () => {
  it.each([
    'He says, "Your adversary the devil".',
    "Now, fellas, you got, you gotta recognize him, 'cause, 'cause notice what he says there.",
    "And Jesus said this to Peter.",
    'He said, "Now, Peter, if I don\'t wash your feet, you\'ll have no part in me.',
    'And he says in verse eight, "Be sober, be vigilant; because your adversary',
  ])("flags a line that only leads into a quotation: %s", (text) => {
    expect(endsOnQuotationStart(text)).toBe(true);
  });

  it.each([
    "Secondly, you need to resist him.",
    "Be vigilant.",
    "he's setting you up.",
    "Grace is a gift. You cannot earn it, and you will never deserve it.",
  ])("does not flag a line that lands a point: %s", (text) => {
    expect(endsOnQuotationStart(text)).toBe(false);
  });
});

describe("applyBoundaryChoice never ends on the start of a quotation", () => {
  const context = boundaryContext(CLIP5, { startMs: 3455184, endMs: 3522400 }, 90_000);
  const at = (idx: number) => context.units.findIndex((u) => u.idx === idx);

  it("steps the end back past every lead-in line, onto Jake's chosen end", () => {
    expect(applyBoundaryChoice(context, { startUnit: at(898), endUnit: at(915) })).toEqual({
      startMs: 3455184,
      endMs: 3513400,
      adjustedForScripture: false,
      adjustedEnd: true,
    });
  });

  it("refuses the choice when stepping back leaves the clip too short", () => {
    expect(applyBoundaryChoice(context, { startUnit: at(912), endUnit: at(915) })).toBeNull();
  });
});

describe("boundaryPrompt teaches Jake's corrections", () => {
  const prompt = boundaryPrompt(boundaryContext(CLIP5, { startMs: 3455184, endMs: 3522400 }, 90_000));

  it("states the start and end rules", () => {
    expect(prompt).toMatch(/speaks (directly )?to the listener/i);
    expect(prompt).toMatch(/punch line/i);
    expect(prompt).toMatch(/never end in the middle of a dialogue/i);
  });

  it("includes his three worked examples from lab sermon 1c", () => {
    expect(prompt).toContain("I'm speaking to somebody today");
    expect(prompt).toContain("Be vigilant.");
    expect(prompt).toContain("Secondly, you need to resist him.");
    expect(prompt).toContain("you're not gonna wash my feet, Jesus.");
  });
});

describe("boundaryPrompt aims for 30 to 55 seconds and teaches Jake's sermon 3 notes", () => {
  const prompt = boundaryPrompt(boundaryContext(CLIP5, { startMs: 3455184, endMs: 3522400 }, 90_000));

  it("aims for 30 to 55 seconds and goes shorter only when the lines around it are a different idea", () => {
    // Lab sermon 3 clip 6 (17 s): "This could pass by itself, but I feel like it could be a longer clip."
    expect(prompt).toMatch(/aim for 30 to 55 seconds/i);
    expect(prompt).toMatch(/under 30 seconds only when/i);
    expect(prompt).toMatch(/15 and 59 seconds/);
  });

  it("includes his two sermon 3 corrections as worked examples 4 and 5", () => {
    expect(prompt).toContain("4. ");
    expect(prompt).toContain("Now let me ask you something.");
    expect(prompt).toContain("it keeps us from getting saved or selling out to the Lord Jesus Christ.");
    expect(prompt).toContain("5. ");
    expect(prompt).toContain("We just stay up weeks at a time.");
    expect(prompt).toContain("Amen?");
    expect(prompt).toContain("And guys");
  });
});

// Units of 2.9 s every 3 s: unit i runs i*3000 to i*3000+2900.
const EVEN = boundaryContext(
  Array.from({ length: 40 }, (_, i) => ({ idx: i, startMs: i * 3_000, endMs: i * 3_000 + 2_900, text: `Point ${i}.` })),
  { startMs: 30_000, endMs: 60_000 },
  90_000,
);

describe("boundaryRefusal", () => {
  it("returns null for a choice the code accepts", () => {
    expect(boundaryRefusal(EVEN, { startUnit: 5, endUnit: 20 })).toBeNull();
  });

  it("explains a choice that runs 60 seconds or more", () => {
    const reason = boundaryRefusal(EVEN, { startUnit: 0, endUnit: 20 });
    expect(reason).toMatch(/62\.9 seconds/);
    expect(reason).toMatch(/under 60 seconds/);
  });

  it("explains a choice that is too short after the end steps back past a quotation lead-in", () => {
    const context = boundaryContext(CLIP5, { startMs: 3455184, endMs: 3522400 }, 90_000);
    const at = (idx: number) => context.units.findIndex((u) => u.idx === idx);
    const reason = boundaryRefusal(context, { startUnit: at(912), endUnit: at(915) });
    expect(reason).toMatch(/4\.4 seconds/);
    expect(reason).toMatch(/at least 15 seconds/);
    expect(reason).toMatch(/quotation/);
  });

  it("explains a reversed or unlisted range", () => {
    expect(boundaryRefusal(EVEN, { startUnit: 9, endUnit: 3 })).toMatch(/not a valid range/);
    expect(boundaryRefusal(EVEN, { startUnit: 0, endUnit: 99 })).toMatch(/not a valid range/);
  });
});

describe("chooseBoundary", () => {
  it("uses a good first answer with one model call", async () => {
    const ask = vi.fn().mockResolvedValue({ startUnit: 5, endUnit: 20, reason: "whole point" });
    const result = await chooseBoundary(EVEN, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.range).toMatchObject({ startMs: 15_000, endMs: 62_900 });
    expect(result.attempts).toEqual([{ startUnit: 5, endUnit: 20, reason: "whole point", refused: null }]);
  });

  it("asks once more with the reason when the first answer is refused, and uses the second", async () => {
    // Lab sermon 3 clip 5: the only answer was too long, so the clip kept its raw window.
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 0, endUnit: 25, reason: "the whole story" })
      .mockResolvedValueOnce({ startUnit: 5, endUnit: 20, reason: "shorter" });
    const result = await chooseBoundary(EVEN, ask);

    expect(ask).toHaveBeenCalledTimes(2);
    const turns = ask.mock.calls[1][0];
    expect(turns).toHaveLength(3);
    expect(turns[0]).toEqual({ role: "user", content: boundaryPrompt(EVEN) });
    expect(turns[1].role).toBe("assistant");
    expect(JSON.parse(turns[1].content)).toMatchObject({ startUnit: 0, endUnit: 25 });
    expect(turns[2].role).toBe("user");
    expect(turns[2].content).toMatch(/77\.9 seconds/);
    expect(turns[2].content).toMatch(/choose again/i);
    expect(result.range).toMatchObject({ startMs: 15_000, endMs: 62_900 });
    expect(result.attempts.map((a) => a.refused === null)).toEqual([false, true]);
  });

  it("gives up after the second refused answer", async () => {
    const ask = vi.fn().mockResolvedValue({ startUnit: 0, endUnit: 30, reason: "everything" });
    const result = await chooseBoundary(EVEN, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.range).toBeNull();
    expect(result.attempts).toHaveLength(2);
  });
});

// Lab sermon 1d (2026-10-18), real Scribe segments. Clip 1 ended on segment 568, so it stopped on
// "because that bath referred" and cut off "to salvation." Jake: "It either stopped too early and
// didn't finish the point". About 8 in 100 segments stop in the middle of a sentence.
const SPLIT_SENTENCES = [
  { idx: 566, startMs: 2401888, endMs: 2403028, text: "And this is what Jesus said." },
  { idx: 567, startMs: 2403068, endMs: 2409248, text: 'He said, "Peter, he that had a bath doesn\'t need to be washed except his feet."' },
  { idx: 568, startMs: 2410228, endMs: 2419048, text: "Now, folks, Jesus makes it very clear here that he's doing this as a symbolic act because that bath referred" },
  { idx: 569, startMs: 2419108, endMs: 2420088, text: "to salvation." },
  { idx: 570, startMs: 2421348, endMs: 2429668, text: "The washing, therefore, of Peter's feet was symbolic of the fact that, that even though we've been saved, we're walking" },
  { idx: 571, startMs: 2429728, endMs: 2430728, text: "in a dirty world." },
  { idx: 572, startMs: 2431868, endMs: 2431988, text: "Yeah." },
];

describe("wholeSentences (fix C)", () => {
  it("joins a segment that stops mid-sentence to the segments that finish the sentence", () => {
    expect(wholeSentences(SPLIT_SENTENCES)).toEqual([
      SPLIT_SENTENCES[0],
      SPLIT_SENTENCES[1],
      {
        idx: 568,
        startMs: 2410228,
        endMs: 2420088,
        text: "Now, folks, Jesus makes it very clear here that he's doing this as a symbolic act because that bath referred to salvation.",
      },
      {
        idx: 570,
        startMs: 2421348,
        endMs: 2430728,
        text: "The washing, therefore, of Peter's feet was symbolic of the fact that, that even though we've been saved, we're walking in a dirty world.",
      },
      SPLIT_SENTENCES[6],
    ]);
  });

  it("keeps a sentence that closes with a quote mark, and a trailing unfinished segment", () => {
    const units = wholeSentences([
      { idx: 1, startMs: 0, endMs: 1_000, text: 'He said, "Go."' },
      { idx: 2, startMs: 1_000, endMs: 2_000, text: "And then he" },
    ]);
    expect(units.map((u) => u.text)).toEqual(['He said, "Go."', "And then he"]);
  });

  it("gives the boundary step whole sentences, so no clip can end on half of one", () => {
    const context = boundaryContext(SPLIT_SENTENCES, { startMs: 2401888, endMs: 2419048 }, 90_000);
    expect(context.units.map((u) => u.idx)).toEqual([566, 567, 568, 570, 572]);
    expect(context.units[context.currentEnd].text).toMatch(/referred to salvation\.$/);
    expect(applyBoundaryChoice(context, { startUnit: 0, endUnit: 2 })).toMatchObject({ endMs: 2420088 });
    expect(boundaryPrompt(context)).not.toMatch(/referred\n/);
  });
});

// Lab sermon 1d clip 3 (2026-10-18), real lines. The clip ended on the question; Jake: "probably
// should end with 'A- and you know what Jesus wants to do today? He wants to wash your feet.'"
const QUESTION = boundaryContext(
  [
    ...Array.from({ length: 10 }, (_, i) => ({ idx: 570 + i, startMs: 2440000 + i * 3_000, endMs: 2440000 + i * 3_000 + 2_900, text: `Point ${i}.` })),
    { idx: 586, startMs: 2472428, endMs: 2472848, text: "Yeah." },
    { idx: 587, startMs: 2472888, endMs: 2477228, text: "What we are to put on that towel gird about us at all times." },
    { idx: 588, startMs: 2477928, endMs: 2479928, text: "A- and you know what Jesus wants to do today?" },
    { idx: 589, startMs: 2481108, endMs: 2482428, text: "He wants to wash your feet." },
    { idx: 590, startMs: 2482888, endMs: 2483528, text: "Amen?" },
    { idx: 591, startMs: 2483588, endMs: 2484868, text: "He wants to restore you." },
  ],
  { startMs: 2440000, endMs: 2479928 },
  90_000,
);
const atQ = (idx: number) => QUESTION.units.findIndex((u) => u.idx === idx);

describe("boundaryPrompt: a question needs its answer (fix D)", () => {
  const prompt = boundaryPrompt(QUESTION);

  it("tells the model to end after the answer, and to end on a question only before a new idea", () => {
    expect(prompt).toMatch(/asks a question and then answers it, or asks the same question again/);
    expect(prompt).toMatch(/end after his answer/);
    expect(prompt).toMatch(/End on a question only when the next line starts a new idea/);
  });

  it("no longer tells the model never to run on into the next sentence", () => {
    expect(prompt).not.toMatch(/the next sentence/);
    expect(prompt).toContain("Never run on into the laughter or the next idea.");
  });
});

describe("chooseBoundary checks an end on a question once (fix D)", () => {
  it("asks once more when the end is a question, quoting it, and uses the answer that ends after it", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 0, endUnit: atQ(588), reason: "ends on the question" })
      .mockResolvedValueOnce({ startUnit: 0, endUnit: atQ(589), reason: "ends on his answer" });
    const result = await chooseBoundary(QUESTION, ask);

    expect(ask).toHaveBeenCalledTimes(2);
    const turns = ask.mock.calls[1][0];
    expect(turns).toHaveLength(3);
    expect(turns[1].role).toBe("assistant");
    expect(turns[2].role).toBe("user");
    expect(turns[2].content).toContain(`Unit [${atQ(588)}] ends on a question: "A- and you know what Jesus wants to do today?"`);
    expect(turns[2].content).toMatch(/answers it or asks it again, end after his answer/);
    expect(turns[2].content).toMatch(/starts a new idea, return the same end/);
    expect(result.range).toMatchObject({ startMs: 2440000, endMs: 2482428 });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ refused: null, question: "A- and you know what Jesus wants to do today?" });
    expect(result.attempts[1]).toMatchObject({ refused: null });
  });

  it("keeps the same end when the model says a new idea starts next", async () => {
    const ask = vi.fn().mockResolvedValue({ startUnit: 0, endUnit: atQ(588), reason: "a new idea starts next" });
    const result = await chooseBoundary(QUESTION, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.range).toMatchObject({ endMs: 2479928 });
  });

  it("keeps the first answer when the second one is refused", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 0, endUnit: atQ(588), reason: "ends on the question" })
      .mockResolvedValueOnce({ startUnit: atQ(591), endUnit: atQ(591), reason: "too short" });
    const result = await chooseBoundary(QUESTION, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.range).toMatchObject({ startMs: 2440000, endMs: 2479928 });
    expect(result.attempts[1].refused).toMatch(/at least 15 seconds/);
  });

  it("does not check a short call-out such as \"Amen?\"", async () => {
    const ask = vi.fn().mockResolvedValue({ startUnit: 0, endUnit: atQ(590), reason: "ends on Amen" });
    const result = await chooseBoundary(QUESTION, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.attempts[0].question).toBeUndefined();
  });

  it("does not check a question with no lines after it", async () => {
    const last = QUESTION.units.length - 1;
    const context = { ...QUESTION, units: [...QUESTION.units.slice(0, last), { ...QUESTION.units[last], text: "Will you let him wash your feet?" }] };
    const ask = vi.fn().mockResolvedValue({ startUnit: 0, endUnit: last, reason: "last line" });
    await chooseBoundary(context, ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
