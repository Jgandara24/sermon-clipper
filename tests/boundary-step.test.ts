import { describe, expect, it, vi } from "vitest";
import {
  announcedListWithOnlyFirst,
  applyBoundaryChoice,
  BOUNDARY_MAX_MS,
  boundaryRefusal,
  chooseBoundary,
  correctionAtStart,
  endLookLines,
  endLookPrompt,
  endsInsideList,
  endsInsideParallelBlock,
  endsOnQuotationStart,
  checkStory,
  endsOnRecapIntoNextPoint,
  endBeforeNextPoint,
  labelStart,
  opensNextPoint,
  recapIntoNextPoint,
  sectionBreak,
  sectionBreakInside,
  readsVerse,
  readsVerseNext,
  storyLookLines,
  storyPrompt,
  boundaryContext,
  boundaryPrompt,
  looksLikeScriptureReadingStart,
  lookPastTheEnd,
  prayerInClip,
  wholeSentences,
  type BoundaryUnit,
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
    expect(prompt).toMatch(/start on the hook/i);
    expect(prompt).toMatch(/where the point lands/i);
    expect(prompt).toMatch(/never start on the scripture reading/i);
    expect(prompt).toMatch(/30 to 60 seconds/);
    expect(prompt).toMatch(/never go past 90 seconds/i);
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
    expect(result).toEqual({ startMs: 4308684, endMs: 4342000, adjustedForScripture: false, adjustedStart: false, adjustedEnd: false });
  });

  it("steps past a Scripture reading at the start, through the end of the quoted passage", () => {
    // 1179 opens the quote of Ephesians 2:8-9 and 1180 closes it; the preacher resumes at 1181.
    const result = applyBoundaryChoice(context, { startUnit: at(1179), endUnit: at(1184) });
    expect(result).toEqual({ startMs: 4324684, endMs: 4342000, adjustedForScripture: true, adjustedStart: false, adjustedEnd: false });
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

  it("accepts a clip of up to 90 seconds and refuses a longer one (Jake, 2026-10-20)", () => {
    // "If the clip's main point goes past 60 seconds and closer to something like 75 seconds, then
    // let it be. Try to refrain from going past 90 seconds."
    const units = Array.from({ length: 40 }, (_, i) => ({ idx: i, startMs: i * 3_000, endMs: i * 3_000 + 2_900, text: "Point." }));
    const context = boundaryContext(units, { startMs: 30_000, endMs: 60_000 }, 90_000);
    expect(applyBoundaryChoice(context, { startUnit: 0, endUnit: 24 })).toMatchObject({ startMs: 0, endMs: 74_900 });
    expect(applyBoundaryChoice(context, { startUnit: 0, endUnit: 29 })).toEqual({ startMs: 0, endMs: 89_900, adjustedForScripture: false, adjustedStart: false, adjustedEnd: false });
    expect(applyBoundaryChoice(context, { startUnit: 0, endUnit: 30 })).toBeNull();
    expect(BOUNDARY_MAX_MS).toBe(90_000);
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
    // Fix I1, real lines from the lab sermons: a lead word before "what" announces the quotation.
    "But I want you to notice what he says here.",
    "And this is what Jesus said.",
    "Now listen what He says.",
    "Now, now follow what the Word of God says here.",
    "And I'll never forget what Brother Bobby said to me.",
    "And, and I love what he said.",
    "And then when Jesus, on the mountain of transfiguration, shows his glory, God says it again.",
  ])("flags a line that only leads into a quotation: %s", (text) => {
    expect(endsOnQuotationStart(text)).toBe(true);
  });

  it.each([
    "Secondly, you need to resist him.",
    "Be vigilant.",
    "he's setting you up.",
    "Grace is a gift. You cannot earn it, and you will never deserve it.",
    // Fix I1: lines that end on "says" but close a point. Lab sermon 4b clip 4 (2026-10-19) lost
    // its last line to this check twice; Jake: "It cuts him off."
    "I'm tellin' you, brother, the best is yet to come according to what the word of God says.",
    "That's what the word of God says.",
    "That's what Jesus said.",
    "And what we need today is we need some believers in Jesus Christ who will act like what this book says.",
  ])("does not flag a line that lands a point: %s", (text) => {
    expect(endsOnQuotationStart(text)).toBe(false);
  });

  // Fix O (2026-10-21): in 173 marked clips the check moved an end back 3 times, and all 3 failed.
  // Lab sermon 5d clip 5 lost "Jesus said, ..."; Jake: 'Should have ended with, "Jesus said, "Ask and
  // you shall receive." Amen."'
  it.each([
    'Jesus said, "Ask and you shall receive."',
    'God says right here, "I\'m providing one way for sinners to be saved."',
    'He said, "I can\'t do that right now."',
    'And he said, "Young man, can I read you something out of this book?"',
  ])("does not flag a line whose quotation is a whole sentence (fix O): %s", (text) => {
    expect(endsOnQuotationStart(text)).toBe(false);
  });

  it.each([
    // The period is outside the quotation marks: the verse goes on (lab sermon 1c clip 5).
    'He says, "Your adversary the devil".',
    // The quotation does not close in the line.
    'He said, "Moreover, I will be careful to ensure you that, that you always have a reminder of these things',
    // A whole verse, but a Scripture reading starts here.
    'The Bible says in verse 30, "And when they said these things the king stood up, as well as the governor."',
  ])("still flags a quotation that is not a whole sentence, or a reading (fix O): %s", (text) => {
    expect(endsOnQuotationStart(text)).toBe(true);
  });
});

// Real lines from lab sermon 5d around clip 5 (42:02–42:23), which Jake failed on test 1.
const FIVE_D_C5 = [
  { idx: 639, startMs: 2508616, endMs: 2510436, text: "Prayer." },
  { idx: 640, startMs: 2510496, endMs: 2518576, text: "And then in Acts 4, the Bible says they prayed, and when they prayed the place was shaken and they were filled with" },
  { idx: 641, startMs: 2518616, endMs: 2522396, text: "the Holy Spirit, and they preached the Word of God with boldness." },
  { idx: 642, startMs: 2522496, endMs: 2522776, text: "Yes." },
  { idx: 643, startMs: 2522896, endMs: 2524636, text: "I am telling you it only takes one." },
  { idx: 644, startMs: 2525096, endMs: 2533096, text: "It just takes one who's willing to pray, one who's willing to grab ahold of heaven, one who's willing to stand on the Word of God, one who's will- willing to believe the" },
  { idx: 645, startMs: 2533136, endMs: 2536436, text: "promises of God, one who is willing to take God seriously." },
  { idx: 646, startMs: 2536476, endMs: 2542196, text: "It just takes one or two to begin to pray, to rip open the sky and have heaven come down and glory- Yeah ..." },
  { idx: 647, startMs: 2542196, endMs: 2543216, text: "to fill our souls." },
  { idx: 648, startMs: 2543316, endMs: 2547376, text: 'Jesus said, "Ask and you shall receive."' },
  { idx: 649, startMs: 2547436, endMs: 2548556, text: "Amen." },
  { idx: 650, startMs: 2548616, endMs: 2551696, text: 'Then he said, "Seek and you shall find."' },
  { idx: 651, startMs: 2552716, endMs: 2556396, text: 'Then he said, "Knock and the door will be opened."' },
  { idx: 652, startMs: 2556576, endMs: 2556916, text: "Amen." },
  { idx: 653, startMs: 2556956, endMs: 2559476, text: "Do you ever notice the first letter of each of those words?" },
];

describe("applyBoundaryChoice keeps an end on a whole quoted sentence (fix O, lab sermon 5d clip 5)", () => {
  const context = boundaryContext(FIVE_D_C5, { startMs: 2518466, endMs: 2542346 }, 90_000);
  const at = (idx: number) => context.units.findIndex((u) => u.idx === idx);

  it("ends on the model's chosen line, 'Jesus said, \"Ask and you shall receive.\"'", () => {
    expect(applyBoundaryChoice(context, { startUnit: at(643), endUnit: at(648) })).toEqual({
      startMs: 2522896,
      endMs: 2547376,
      adjustedForScripture: false,
      adjustedStart: false,
      adjustedEnd: false,
    });
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
      adjustedStart: false,
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

describe("boundaryPrompt aims for 30 to 60 seconds and teaches Jake's sermon 3 notes", () => {
  const prompt = boundaryPrompt(boundaryContext(CLIP5, { startMs: 3455184, endMs: 3522400 }, 90_000));

  it("aims for 30 to 60 seconds and goes shorter only when the lines around it are a different idea", () => {
    // Lab sermon 3 clip 6 (17 s): "This could pass by itself, but I feel like it could be a longer clip."
    expect(prompt).toMatch(/aim for 30 to 60 seconds/i);
    expect(prompt).toMatch(/under 30 seconds only when/i);
  });

  it("lets a point that needs it run to 75 seconds, and never past 90 (Jake, 2026-10-20)", () => {
    expect(prompt).toMatch(/up to 75 seconds is fine/i);
    expect(prompt).toMatch(/never go past 90 seconds/i);
    expect(prompt).not.toMatch(/under 60 seconds/i);
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

  it("explains a choice that runs past 90 seconds, and says to keep the end and start later", () => {
    expect(boundaryRefusal(EVEN, { startUnit: 0, endUnit: 20 })).toBeNull();
    const reason = boundaryRefusal(EVEN, { startUnit: 0, endUnit: 31 });
    expect(reason).toMatch(/95\.9 seconds/);
    expect(reason).toMatch(/must not run past 90 seconds/);
    expect(reason).toMatch(/keep the end where the point ends and start later/i);
    // Gate run, 2026-10-20: told only "not past 90", the model started 1g clip 3 just late enough to
    // run 89.9 seconds.
    expect(reason).toMatch(/30 to 60 seconds, or 75 at most/);
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
      .mockResolvedValueOnce({ startUnit: 0, endUnit: 35, reason: "the whole story" })
      .mockResolvedValueOnce({ startUnit: 13, endUnit: 35, reason: "start later" });
    const result = await chooseBoundary(EVEN, ask);

    expect(ask).toHaveBeenCalledTimes(2);
    const turns = ask.mock.calls[1][0];
    expect(turns).toHaveLength(3);
    expect(turns[0]).toEqual({ role: "user", content: boundaryPrompt(EVEN) });
    expect(turns[1].role).toBe("assistant");
    expect(JSON.parse(turns[1].content)).toMatchObject({ startUnit: 0, endUnit: 35 });
    expect(turns[2].role).toBe("user");
    expect(turns[2].content).toMatch(/107\.9 seconds/);
    expect(turns[2].content).toMatch(/choose again/i);
    expect(result.range).toMatchObject({ startMs: 39_000, endMs: 107_900 });
    expect(result.attempts.map((a) => a.refused === null)).toEqual([false, true]);
  });

  it("gives up after the third refused answer", async () => {
    // Fix I2 refuses more answers (an end inside a list), so a refused answer gets two more tries.
    const ask = vi.fn().mockResolvedValue({ startUnit: 0, endUnit: 30, reason: "everything" });
    const result = await chooseBoundary(EVEN, ask);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(result.range).toBeNull();
    expect(result.attempts).toHaveLength(3);
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

  it("tells the model to keep going to the answer, not to cut the question out (dry run, 2026-10-18)", () => {
    // On the first dry run the model ended 1d clip 3 and 2b clip 6 before the question instead.
    expect(prompt).toMatch(/keep going and end after his answer/);
    expect(prompt).toMatch(/Never end the clip early to leave a question out/);
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
    expect(turns[2].content).toMatch(/do not end before the question/);
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

  it("gives a refused answer to the question check one more try, and uses it", async () => {
    // Dry run, 2b clip 6: the model kept going to the answer but ran over 60 seconds, so the clip
    // fell back to its first, shorter end.
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 0, endUnit: atQ(588), reason: "ends on the question" })
      .mockResolvedValueOnce({ startUnit: atQ(591), endUnit: atQ(591), reason: "too short" })
      .mockResolvedValueOnce({ startUnit: 1, endUnit: atQ(589), reason: "ends on his answer" });
    const result = await chooseBoundary(QUESTION, ask);
    expect(ask).toHaveBeenCalledTimes(3);
    const turns = ask.mock.calls[2][0];
    expect(turns).toHaveLength(5);
    expect(turns[4].content).toMatch(/Your answer was refused: .*at least 15 seconds/);
    expect(result.range).toMatchObject({ startMs: 2443000, endMs: 2482428 });
    expect(result.attempts.map((a) => a.refused === null)).toEqual([true, false, true]);
  });

  it("keeps the first answer when the question check's answers are refused twice", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 0, endUnit: atQ(588), reason: "ends on the question" })
      .mockResolvedValue({ startUnit: atQ(591), endUnit: atQ(591), reason: "too short" });
    const result = await chooseBoundary(QUESTION, ask);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(result.range).toMatchObject({ startMs: 2440000, endMs: 2479928 });
    expect(result.attempts[1].refused).toMatch(/at least 15 seconds/);
  });

  it("does not check a short call-out such as \"Amen?\"", async () => {
    const ask = vi.fn().mockResolvedValue({ startUnit: 0, endUnit: atQ(590), reason: "ends on Amen" });
    const result = await chooseBoundary(QUESTION, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.attempts[0].question).toBeUndefined();
  });

  it("checks the question of an answer accepted after a refusal", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: atQ(591), endUnit: atQ(591), reason: "too short" })
      .mockResolvedValueOnce({ startUnit: 0, endUnit: atQ(588), reason: "ends on the question" })
      .mockResolvedValueOnce({ startUnit: 0, endUnit: atQ(589), reason: "ends on his answer" });
    const result = await chooseBoundary(QUESTION, ask);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(ask.mock.calls[2][0][4].content).toContain("ends on a question");
    expect(result.range).toMatchObject({ endMs: 2482428 });
  });

  it("makes five model calls at most", async () => {
    const tooShort = { startUnit: atQ(591), endUnit: atQ(591), reason: "too short" };
    const ask = vi
      .fn()
      .mockResolvedValueOnce(tooShort)
      .mockResolvedValueOnce(tooShort)
      .mockResolvedValueOnce({ startUnit: 0, endUnit: atQ(588), reason: "ends on the question" })
      .mockResolvedValue(tooShort);
    const result = await chooseBoundary(QUESTION, ask);
    expect(ask).toHaveBeenCalledTimes(5);
    expect(result.range).toMatchObject({ startMs: 2440000, endMs: 2479928 });
  });

  it("does not check a question with no lines after it", async () => {
    const last = QUESTION.units.length - 1;
    const context = { ...QUESTION, units: [...QUESTION.units.slice(0, last), { ...QUESTION.units[last], text: "Will you let him wash your feet?" }] };
    const ask = vi.fn().mockResolvedValue({ startUnit: 0, endUnit: last, reason: "last line" });
    await chooseBoundary(context, ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

// Lab sermon 4b clip 4 (2026-10-19), real lines. Jake: "It cuts him off. and it seems like he wasn't
// finished making his final point." The clip ended on "We're gonna live …", inside a list; the
// quotation check had removed the line that lands it, "the best is yet to come".
const FOUR_B_C4 = boundaryContext(
  [
    { idx: 456, startMs: 2133709, endMs: 2137250, text: "So this is what I want you to know concerning the death of a Christian." },
    { idx: 457, startMs: 2137610, endMs: 2139750, text: "Know this for certain." },
    { idx: 458, startMs: 2140550, endMs: 2144310, text: "Born again Christians never die." },
    { idx: 459, startMs: 2144910, endMs: 2146950, text: "Your baby is alive." },
    { idx: 460, startMs: 2147170, endMs: 2149290, text: "Your mom is alive." },
    { idx: 461, startMs: 2149570, endMs: 2151670, text: "Your dad is alive." },
    { idx: 462, startMs: 2151890, endMs: 2156310, text: "Your brother or sister in Jesus Christ is alive." },
    { idx: 463, startMs: 2156650, endMs: 2158530, text: "They know the Lord." },
    { idx: 464, startMs: 2158830, endMs: 2161330, text: "They've been washed in the blood." },
    { idx: 465, startMs: 2161610, endMs: 2165110, text: "I want you to know that there's hope beyond the grave." },
    { idx: 466, startMs: 2165410, endMs: 2169190, text: "I want you to know that this is not all there is." },
    { idx: 467, startMs: 2169410, endMs: 2175830, text: "We're not gonna be out there like some mist, like Casper the Friendly Ghost, friendly ghost runnin' around." },
    { idx: 468, startMs: 2175850, endMs: 2179010, text: "Brother, I'm tellin' you, we're gonna stand on a street of gold." },
    { idx: 469, startMs: 2179230, endMs: 2183610, text: "We're gonna live in a dwelling place that's been constructed by the Lord Jesus Christ." },
    { idx: 470, startMs: 2183830, endMs: 2185670, text: "We're gonna sing in a heavenly choir." },
    { idx: 471, startMs: 2185870, endMs: 2187990, text: "We're gonna breathe celestial air." },
    { idx: 472, startMs: 2188290, endMs: 2193370, text: "I'm tellin' you, brother, the best is yet to come according to what the word of God says." },
    { idx: 473, startMs: 2196170, endMs: 2200270, text: "Did you notice how he used that word decease in verse 15?" },
  ],
  { startMs: 2133709, endMs: 2183610 },
  90_000,
);
const at4 = (idx: number) => FOUR_B_C4.units.findIndex((u) => u.idx === idx);

// Lab sermon 4b clip 1 (2026-10-19), real lines. Jake: "Should have probably ended at "And
// everywhere God speaks, it is absolute truth. Amen."" It ended on the first of six "What God says
// about … is absolutely true." lines.
const FOUR_B_C1 = boundaryContext(
  [
    { idx: 758, startMs: 3363766, endMs: 3370726, text: "So I'm telling you today, my friend, this is the Word of God from beginning to end." },
    { idx: 759, startMs: 3371366, endMs: 3373486, text: "This doesn't become the Word of God." },
    { idx: 760, startMs: 3373846, endMs: 3376106, text: "This doesn't contain the Word of God." },
    { idx: 761, startMs: 3376566, endMs: 3379386, text: "This is the Word of God." },
    { idx: 762, startMs: 3379826, endMs: 3379846, text: "Amen." },
    { idx: 763, startMs: 3379866, endMs: 3382066, text: "God has spoken to us." },
    { idx: 764, startMs: 3382286, endMs: 3383426, text: "It is inspired." },
    { idx: 765, startMs: 3383666, endMs: 3385466, text: "It is full of the Holy Spirit." },
    { idx: 766, startMs: 3385966, endMs: 3388105, text: "That's why it ignites faith." },
    { idx: 767, startMs: 3388426, endMs: 3391766, text: "That's why it changes us from glory to glory." },
    { idx: 768, startMs: 3392046, endMs: 3396506, text: "And everywhere God speaks, it is absolute truth." },
    { idx: 769, startMs: 3396806, endMs: 3397886, text: "Amen." },
    { idx: 770, startMs: 3397946, endMs: 3401986, text: "What God says about creation is absolutely true." },
    { idx: 771, startMs: 3402686, endMs: 3405926, text: "God created man, uh, from the very dust of the ground." },
    { idx: 772, startMs: 3406206, endMs: 3410506, text: "God took a rib out of Adam's side, and God made a man and a woman." },
    { idx: 773, startMs: 3410746, endMs: 3414526, text: "What God says about marriage is absolutely true." },
    { idx: 774, startMs: 3414766, endMs: 3419206, text: "What God says today about gender is absolutely true." },
    { idx: 775, startMs: 3419486, endMs: 3424326, text: "What God says today about heaven is absolutely true." },
    { idx: 776, startMs: 3424546, endMs: 3429146, text: "What God says about hell is absolutely true." },
    { idx: 777, startMs: 3429346, endMs: 3435726, text: "What God says about the second coming of Jesus Christ is absolutely true." },
    { idx: 778, startMs: 3437286, endMs: 3437506, text: "Amen." },
    { idx: 779, startMs: 3437506, endMs: 3446046, text: 'And so in verse 19, he says, "Until the day dawns and the morning star rises."' },
  ],
  { startMs: 3363766, endMs: 3401986 },
  90_000,
);
const at1 = (idx: number) => FOUR_B_C1.units.findIndex((u) => u.idx === idx);

// Lab sermon 1f clip 1 (2026-10-19), real lines. Jake: "End on "never forget that" is pretty quick
// cut off. Could probably end on "You've got that today as a believer. Amen." for an eaiser ending."
const ONE_F_C1 = boundaryContext(
  [
    ...Array.from({ length: 8 }, (_, i) => ({ idx: 1200 + i, startMs: 4454000 + i * 4_000, endMs: 4454000 + i * 4_000 + 3_900, text: `Point ${i}.` })),
    { idx: 1216, startMs: 4490324, endMs: 4493024, text: 'I mean, there\'s times I\'m thinking, "Man, how in the world am I gonna do this?' },
    { idx: 1217, startMs: 4493324, endMs: 4494484, text: 'How am I gonna get through this?"' },
    { idx: 1218, startMs: 4494704, endMs: 4496904, text: "But it's the grace of God that strengthens us." },
    { idx: 1219, startMs: 4497144, endMs: 4498824, text: "When I am weak, He is strong." },
    { idx: 1220, startMs: 4498864, endMs: 4499544, text: "Never forget that." },
    { idx: 1221, startMs: 4499604, endMs: 4501264, text: "You've got that today as a believer." },
    { idx: 1222, startMs: 4501804, endMs: 4501884, text: "Amen." },
    { idx: 1223, startMs: 4501884, endMs: 4502744, text: "You've got that today." },
    { idx: 1224, startMs: 4502824, endMs: 4505384, text: 'Some of you here today, you\'re like, "How am I gonna get through what I\'m gonna get through?"' },
    { idx: 1225, startMs: 4505600, endMs: 4507300, text: "You've got the sustaining grace of God." },
  ],
  { startMs: 4454000, endMs: 4499544 },
  90_000,
);
const at1f = (idx: number) => ONE_F_C1.units.findIndex((u) => u.idx === idx);

describe("fix I1: the quotation check keeps a line that closes the point", () => {
  it("lets lab sermon 4b clip 4 end on \"the best is yet to come\"", () => {
    expect(applyBoundaryChoice(FOUR_B_C4, { startUnit: at4(456), endUnit: at4(472) })).toEqual({
      startMs: 2133709,
      endMs: 2193370,
      adjustedForScripture: false,
      adjustedStart: false,
      adjustedEnd: false,
    });
  });
});

describe("fix I2: no end inside a list", () => {
  it("finds the \"We're gonna\" list, with the line that leads into it", () => {
    expect(endsInsideList(FOUR_B_C4.units, at4(469))).toEqual({ first: at4(468), last: at4(471), opening: "We're gonna" });
    expect(endsInsideList(FOUR_B_C4.units, at4(468))).toMatchObject({ last: at4(471) });
    expect(endsInsideList(FOUR_B_C4.units, at4(470))).toMatchObject({ last: at4(471) });
  });

  it("accepts an end on the last item of a list, after it, or before it", () => {
    expect(endsInsideList(FOUR_B_C4.units, at4(471))).toBeNull();
    expect(endsInsideList(FOUR_B_C4.units, at4(472))).toBeNull();
    expect(endsInsideList(FOUR_B_C4.units, at4(467))).toBeNull();
  });

  it("finds a list whose items have other lines between them", () => {
    expect(endsInsideList(FOUR_B_C1.units, at1(770))).toEqual({ first: at1(770), last: at1(777), opening: "What God" });
    expect(endsInsideList(FOUR_B_C1.units, at1(768))).toBeNull();
    expect(endsInsideList(FOUR_B_C1.units, at1(769))).toBeNull();
  });

  it("needs three items, and does not count short call-outs", () => {
    // "I want you to know that …" twice, and "This doesn't …" twice, are not lists.
    expect(endsInsideList(FOUR_B_C4.units, at4(465))).toBeNull();
    expect(endsInsideList(FOUR_B_C1.units, at1(759))).toBeNull();
    const units = ["That's right.", "Point one is here.", "That's right.", "Point two is here.", "That's right.", "Done now."].map(
      (text, i) => ({ idx: i, startMs: i * 3_000, endMs: i * 3_000 + 2_900, text }),
    );
    expect(endsInsideList(units, 2)).toBeNull();
  });

  it("reads a stammered first word once", () => {
    const units = ["I should've read my Bible more.", "I, I should've prayed a lot more.", "I should've given way more money.", "No."].map((text, i) => ({
      idx: i,
      startMs: i * 3_000,
      endMs: i * 3_000 + 2_900,
      text,
    }));
    expect(endsInsideList(units, 1)).toMatchObject({ first: 0, last: 2 });
  });

  it("does not count a line he restates as a list: lab sermon 1f clip 1, Jake's end after \"Amen.\"", () => {
    // "You've got that today as a believer." "Amen." "You've got that today." … "You've got the
    // sustaining grace of God." Items need five words, so the four-word restatement is not one.
    expect(endsInsideList(ONE_F_C1.units, at1f(1222))).toBeNull();
  });

  it("refuses an end inside a list, and says where the list ends", () => {
    const reason = boundaryRefusal(FOUR_B_C1, { startUnit: at1(758), endUnit: at1(770) });
    expect(reason).toContain(`Unit [${at1(770)}] is inside a list`);
    expect(reason).toContain(`units [${at1(770)}] to [${at1(777)}] start the same way ("What God")`);
    expect(reason).toContain(`End after its last item, unit [${at1(777)}], or before the list starts`);
    expect(reason).toMatch(/Start later if you must/);
    expect(applyBoundaryChoice(FOUR_B_C1, { startUnit: at1(758), endUnit: at1(770) })).toBeNull();
    expect(applyBoundaryChoice(FOUR_B_C1, { startUnit: at1(758), endUnit: at1(769) })).toMatchObject({ endMs: 3397886 });
  });

  it("sends a first answer that ends inside a list back with the reason, and uses the next", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 0, endUnit: at1(770), reason: "first application" })
      .mockResolvedValue({ startUnit: 0, endUnit: at1(769), reason: "absolute truth, Amen" });
    const result = await chooseBoundary(FOUR_B_C1, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0][2].content).toContain("is inside a list");
    expect(result.range).toMatchObject({ startMs: 3363766, endMs: 3397886 });
  });

  it("checks the end that is left after the quotation check steps back", () => {
    // The old quotation check stepped 4b clip 4 back from "the best is yet to come" into the list.
    const context = { ...FOUR_B_C4, units: FOUR_B_C4.units.map((u) => (u.idx === 472 ? { ...u, text: "And notice what he says." } : u)) };
    expect(boundaryRefusal(context, { startUnit: at4(456), endUnit: at4(472) })).toBeNull();
    expect(boundaryRefusal(context, { startUnit: at4(457), endUnit: at4(470) })).toContain("is inside a list");
  });
});

// Lab sermon 4c (2026-10-20), real lines. Clip 6 ran from "death and taxes" (421) to 427, clip 5 from
// 423 to 429. Jake on clip 6: "it feels odd that he says here are three things and he only lists one
// thing."; on clip 5: "it isn't cleanly making a point, rather starting one."
const FOUR_C = boundaryContext(
  [
    { idx: 416, startMs: 1884150, endMs: 1885670, text: "Speak to your people today." },
    { idx: 417, startMs: 1886170, endMs: 1887470, text: "In Jesus' name we pray." },
    { idx: 418, startMs: 1887490, endMs: 1888869, text: "And all God's people said-" },
    { idx: 419, startMs: 1889650, endMs: 1889770, text: "Amen." },
    { idx: 420, startMs: 1889770, endMs: 1890810, text: "Amen and amen." },
    { idx: 421, startMs: 1892370, endMs: 1900610, text: "You know, someone once said that there is nothing certain in life but death and taxes." },
    { idx: 422, startMs: 1901970, endMs: 1908050, text: "And while that's certain, I wanna say that there's actually some other things that are certain." },
    { idx: 423, startMs: 1909410, endMs: 1912810, text: "I call them divine certainties." },
    { idx: 424, startMs: 1913950, endMs: 1922390, text: "In fact, this morning I, I wanna show you three things that are certain in an uncertain world." },
    { idx: 425, startMs: 1923230, endMs: 1930490, text: "First of all, I want you to know that it is for certain that Christians never die." },
    { idx: 426, startMs: 1931890, endMs: 1931970, text: "Amen." },
    { idx: 427, startMs: 1931970, endMs: 1935750, text: "It is for certain that Christians never die." },
    { idx: 428, startMs: 1935970, endMs: 1944390, text: "Look, the Bible says that our understanding at what happens at death is not based on human speculation, but divine revelation." },
    { idx: 429, startMs: 1944930, endMs: 1952810, text: "In fact, the Bible says in verse 12, Simon Peter says it is presented and it stands on the truth of God's word." },
  ],
  { startMs: 1892370, endMs: 1935750 },
  90_000,
);
const at4c = (idx: number) => FOUR_C.units.findIndex((u) => u.idx === idx);
const lines = (texts: string[]) => texts.map((text, i) => ({ idx: i, startMs: i * 4_000, endMs: i * 4_000 + 3_900, text }));

describe("fix K1: no announced list with only its first item", () => {
  it("finds \"three things\" and \"First of all\" with no second item in lab sermon 4c clips 5 and 6", () => {
    expect(announcedListWithOnlyFirst(FOUR_C.units, at4c(421), at4c(427))).toEqual({
      announcement: at4c(424),
      first: at4c(425),
      count: "three things",
      firstWords: "First of all",
    });
    expect(announcedListWithOnlyFirst(FOUR_C.units, at4c(423), at4c(429))).toMatchObject({ announcement: at4c(424), first: at4c(425) });
  });

  it("accepts the clip when the announcement is left out", () => {
    expect(announcedListWithOnlyFirst(FOUR_C.units, at4c(425), at4c(429))).toBeNull();
  });

  it("accepts the clip when it gives the second item too", () => {
    const units = lines([
      "I want to give you two reasons to pray.",
      "First of all, prayer changes you.",
      "Secondly, prayer changes the people you pray for.",
      "Amen.",
    ]);
    expect(announcedListWithOnlyFirst(units, 0, 2)).toBeNull();
    expect(announcedListWithOnlyFirst(units, 0, 1)).toMatchObject({ announcement: 0, first: 1, count: "two reasons" });
  });

  it("accepts a count he lists without \"first\": lab sermon 3e clip 2 (passed)", () => {
    const units = lines([
      "I, I can, I can look at two things you own and tell whether you're sold out to Jesus: your calendar and your checkbook.",
      "Amen.",
    ]);
    expect(announcedListWithOnlyFirst(units, 0, 1)).toBeNull();
  });

  it("refuses the clip and says to start after the announcement", () => {
    const reason = boundaryRefusal(FOUR_C, { startUnit: at4c(421), endUnit: at4c(427) });
    expect(reason).toContain(`Unit [${at4c(424)}] announces "three things"`);
    expect(reason).toContain(`only the first ("First of all", unit [${at4c(425)}])`);
    expect(reason).toContain(`Start after unit [${at4c(424)}]`);
    expect(applyBoundaryChoice(FOUR_C, { startUnit: at4c(421), endUnit: at4c(427) })).toBeNull();
  });
});

// Lab sermon 1g clip 1 (2026-10-20), real lines. Jake: "The pastor mispeaks at the beginning. That's
// not a proper hook ... the beginning has to be clean and catch. Start it right after on, "You know
// the story.""
const ONE_G_C1 = boundaryContext(
  [
    { idx: 1179, startMs: 4441520, endMs: 4442420, text: "But what else is there?" },
    { idx: 1180, startMs: 4443580, endMs: 4447840, text: "Once you get saved, then there is grace that sustains us." },
    { idx: 1181, startMs: 4448400, endMs: 4449860, text: "You got grace that saves us." },
    { idx: 1182, startMs: 4450420, endMs: 4452840, text: "Now Christian, there's grace that saves us." },
    { idx: 1183, startMs: 4454139, endMs: 4455279, text: "I- I'm sorry, sustains us." },
    { idx: 1184, startMs: 4455279, endMs: 4455860, text: "Excuse me." },
    { idx: 1185, startMs: 4456460, endMs: 4457140, text: "Sustains us." },
    { idx: 1186, startMs: 4457320, endMs: 4458060, text: "You know the story." },
    { idx: 1187, startMs: 4458780, endMs: 4460300, text: "Paul had a thorn in his flesh." },
    { idx: 1188, startMs: 4461180, endMs: 4463800, text: "Three times he asked God to remove it." },
    { idx: 1189, startMs: 4464640, endMs: 4466220, text: "God said no all three times." },
    { idx: 1190, startMs: 4466600, endMs: 4467500, text: "But what'd God say?" },
    { idx: 1191, startMs: 4468020, endMs: 4470780, text: 'God said, "My grace is sufficient for you.' },
    { idx: 1192, startMs: 4471340, endMs: 4474800, text: 'My strength is made perfect in weakness."' },
  ],
  { startMs: 4450420, endMs: 4474800 },
  90_000,
);
const at1g = (idx: number) => ONE_G_C1.units.findIndex((u) => u.idx === idx);

describe("fix K3: no start on a correction", () => {
  const SLIP = { first: at1g(1183), last: at1g(1185), words: "I'm sorry" };

  it("finds the correction in the first 15 seconds of lab sermon 1g clip 1, with the words he says again", () => {
    // "I- I'm sorry, sustains us." "Excuse me." "Sustains us." The short line he repeats belongs to it.
    expect(correctionAtStart(ONE_G_C1.units, at1g(1182), at1g(1192))).toEqual(SLIP);
  });

  it("finds it 12.6 seconds in, where the 90-second rule starts the clip (gate run, 2026-10-20)", () => {
    expect(correctionAtStart(ONE_G_C1.units, at1g(1179), at1g(1192))).toEqual(SLIP);
  });

  it("refuses a start on the words he says again, \"Sustains us.\" (gate run 2, 2026-10-20)", () => {
    expect(correctionAtStart(ONE_G_C1.units, at1g(1185), at1g(1192))).toEqual(SLIP);
  });

  it("accepts Jake's start, \"You know the story.\"", () => {
    expect(correctionAtStart(ONE_G_C1.units, at1g(1186), at1g(1192))).toBeNull();
  });

  it("accepts a correction more than 15 seconds into the clip (Jake: in the middle it is probably okay)", () => {
    // Lines start every 4 seconds, so line 4 starts 16 seconds in.
    const whole = "This is a whole point.";
    expect(correctionAtStart(lines([whole, whole, whole, whole, "I'm sorry, the third chapter.", whole]), 0, 5)).toBeNull();
    expect(correctionAtStart(lines([whole, whole, whole, "I'm sorry, the third chapter.", whole]), 0, 4)).toEqual({ first: 3, last: 3, words: "I'm sorry" });
  });

  it("reads \"I mean\" as a correction only after a comma, not as an opening word", () => {
    const whole = "This is a whole point.";
    expect(correctionAtStart(lines(["I mean, here's this big tough guy fisherman, right?", whole]), 0, 1)).toBeNull();
    expect(correctionAtStart(lines(["He was a fisherman, I mean, a tax collector.", whole]), 0, 1)).toEqual({ first: 0, last: 0, words: "I mean" });
    expect(correctionAtStart(lines([whole, "I misspoke there.", whole]), 0, 2)).toEqual({ first: 1, last: 1, words: "I misspoke" });
  });

  it("refuses the clip and says to start after the correction and the words he says again", () => {
    const reason = boundaryRefusal(ONE_G_C1, { startUnit: at1g(1182), endUnit: at1g(1192) });
    expect(reason).toContain(`Units [${at1g(1183)}] to [${at1g(1185)}] are a correction ("I'm sorry")`);
    expect(reason).toContain(`Start after unit [${at1g(1185)}]`);
    expect(boundaryRefusal(ONE_G_C1, { startUnit: at1g(1185), endUnit: at1g(1192) })).toContain("are a correction");
    // Jake: "Start it right after on, "You know the story.""
    expect(boundaryRefusal(ONE_G_C1, { startUnit: at1g(1186), endUnit: at1g(1192) })).toBeNull();
  });
});

// Lab sermon 1g clip 5 (2026-10-20), real lines. Jake: "The pastor is praying, this shouldn't be a
// clip." The prayer comes after the reading, inside the sermon span.
const ONE_G_C5 = boundaryContext(
  [
    { idx: 453, startMs: 2020200, endMs: 2024320, text: "So Lord, as your messenger, I just ask for the anointing of the Holy Spirit right now." },
    { idx: 454, startMs: 2025660, endMs: 2026780, text: "Touch my mind." },
    { idx: 455, startMs: 2027940, endMs: 2028840, text: "Touch my mouth." },
    { idx: 456, startMs: 2029780, endMs: 2031200, text: "Touch the ears that are here today." },
    { idx: 457, startMs: 2032100, endMs: 2038560, text: "Lord, I want to confess today that the devil is a defeated foe, and he has no right in this church house this morning." },
    { idx: 458, startMs: 2039260, endMs: 2043680, text: "For Jesus, you broke his power on the cross and on your resurrection." },
    { idx: 459, startMs: 2044580, endMs: 2048340, text: "So God, today, we celebrate the fact that you wanna move in our lives." },
    { idx: 460, startMs: 2049140, endMs: 2053520, text: "Lord, I know we're not here today by accident, chance, or fate, but it's a divine appointment." },
    { idx: 461, startMs: 2053580, endMs: 2056800, text: "You've come to speak to people today through your Word." },
    { idx: 462, startMs: 2057540, endMs: 2059180, text: "Hide me behind your cross." },
    { idx: 463, startMs: 2060200, endMs: 2062260, text: "I must decrease, and you must increase." },
    { idx: 464, startMs: 2063020, endMs: 2066540, text: "And I pray, Jesus, you'll be glorified in everything we do today." },
    { idx: 465, startMs: 2066980, endMs: 2071240, text: "In Jesus' name we pray, and all God's people said- Amen." },
    { idx: 466, startMs: 2071240, endMs: 2071740, text: "Amen." },
    { idx: 467, startMs: 2072380, endMs: 2080260, text: "Now, I want to remind you here that Peter is writing to these Christians who are going through serious persecution." },
  ],
  { startMs: 2032100, endMs: 2080260 },
  90_000,
);
const at1g5 = (idx: number) => ONE_G_C5.units.findIndex((u) => u.idx === idx);

describe("fix K4: no prayer", () => {
  it("finds the prayer in lab sermon 1g clip 5, from its first \"Lord,\" to \"In Jesus' name we pray\"", () => {
    expect(prayerInClip(ONE_G_C5.units, at1g5(457), at1g5(467))).toEqual({ first: at1g5(457), last: at1g5(465), words: "In Jesus' name we pray" });
  });

  it("finds the end of the prayer before lab sermon 4c clip 6, and accepts clip 6 itself", () => {
    expect(prayerInClip(FOUR_C.units, at4c(416), at4c(424))).toMatchObject({ first: at4c(417), last: at4c(418) });
    expect(prayerInClip(FOUR_C.units, at4c(421), at4c(427))).toBeNull();
  });

  it("finds two lines that speak to the Lord, even with no closing words", () => {
    expect(prayerInClip(ONE_G_C5.units, at1g5(453), at1g5(461))).toEqual({ first: at1g5(453), last: at1g5(460), words: "Lord," });
  });

  it("accepts preaching that names God: lab sermon 1f clip 3 (passed), and one line to the Lord in a story", () => {
    expect(prayerInClip(lines(["God, listen to this, He resists the proud, but He gives grace to the humble.", "Point."]), 0, 1)).toBeNull();
    expect(prayerInClip(lines(["And she cried out, Lord, help me.", "And he did.", "Point."]), 0, 2)).toBeNull();
    expect(prayerInClip(lines(["There is power in Jesus' name.", "Point."]), 0, 1)).toBeNull();
  });

  it("refuses the clip and says to leave the prayer out", () => {
    const reason = boundaryRefusal(ONE_G_C5, { startUnit: at1g5(457), endUnit: at1g5(467) });
    expect(reason).toContain(`Units [${at1g5(457)}] to [${at1g5(465)}] are a prayer ("In Jesus' name we pray")`);
    expect(reason).toMatch(/leaves out all of the prayer/);
    expect(boundaryRefusal(ONE_G_C5, { startUnit: at1g5(467), endUnit: at1g5(467) })).not.toMatch(/prayer/);
  });

  it("tells the model in the prompt", () => {
    expect(boundaryPrompt(ONE_G_C5)).toMatch(/prayer \("Lord, \.\.\."/);
  });
});

describe("fix K2: keep the end when a point runs too long", () => {
  // Lab sermon 5 clip 6 (2026-10-20): the first answer held the whole 188.6-second story; told it was
  // too long, the model ended 93.2 seconds sooner, in the middle of the story. Jake: "It seems like
  // the pastor wasn't done tell the story or making his point."
  it("refuses an answer that ends more than 8 seconds sooner than the answer that ran too long", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 0, endUnit: 35, reason: "the whole story" })
      .mockResolvedValueOnce({ startUnit: 5, endUnit: 20, reason: "the first scene" })
      .mockResolvedValueOnce({ startUnit: 12, endUnit: 35, reason: "the end of the story" });
    const result = await chooseBoundary(EVEN, ask);
    expect(ask).toHaveBeenCalledTimes(3);
    const refused = result.attempts[1].refused!;
    expect(refused).toContain("Your last answer that ran too long ended at unit [35]");
    expect(refused).toContain("This answer ends at unit [20], 45.0 seconds sooner");
    expect(refused).toContain("Keep the end at unit [35] or later, and start later.");
    expect(result.range).toMatchObject({ startMs: 36_000, endMs: 107_900 });
  });

  it("lets a clip cut from a longer point run 75 seconds at most (gate run, 2026-10-20: 1g clip 3 ran 89.9)", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 0, endUnit: 35, reason: "the whole point" })
      .mockResolvedValueOnce({ startUnit: 10, endUnit: 35, reason: "just under 90" })
      .mockResolvedValueOnce({ startUnit: 16, endUnit: 35, reason: "the end of the point" });
    const result = await chooseBoundary(EVEN, ask);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(result.attempts[1].refused).toMatch(/77\.9 seconds/);
    expect(result.attempts[1].refused).toMatch(/must run 75 seconds at most/);
    expect(result.range).toMatchObject({ startMs: 48_000, endMs: 107_900 });
  });

  it("accepts a first answer of 75 to 90 seconds when the point needs it", () => {
    expect(boundaryRefusal(EVEN, { startUnit: 0, endUnit: 25 })).toBeNull();
  });

  it("accepts an end up to 8 seconds sooner", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 0, endUnit: 35, reason: "the whole story" })
      .mockResolvedValueOnce({ startUnit: 12, endUnit: 33, reason: "a little sooner" });
    const result = await chooseBoundary(EVEN, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.range).toMatchObject({ startMs: 36_000, endMs: 101_900 });
  });

  it("does not hold the end of an answer refused for another reason", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 20, endUnit: 21, reason: "too short" })
      .mockResolvedValueOnce({ startUnit: 5, endUnit: 12, reason: "earlier" });
    const result = await chooseBoundary(EVEN, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.range).toMatchObject({ startMs: 15_000, endMs: 38_900 });
  });

  it("holds the end of the latest answer that ran too long", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce({ startUnit: 0, endUnit: 35, reason: "the whole story" })
      .mockResolvedValueOnce({ startUnit: 0, endUnit: 39, reason: "more" })
      .mockResolvedValueOnce({ startUnit: 20, endUnit: 35, reason: "shorter" });
    const result = await chooseBoundary(EVEN, ask);
    expect(result.attempts[2].refused).toContain("ended at unit [39]");
    expect(result.range).toBeNull();
  });
});

// Lab sermon 1j clip 4 (2026-10-20), real lines. The clip ended on 880; Jake: "It should end with,
// " Amen. He is the devil.""
const ONE_J_C4 = [
  { idx: 877, startMs: 3524472, endMs: 3527312, text: "Friend, did you know you have an adversary?" },
  { idx: 878, startMs: 3528232, endMs: 3528572, text: "Oh, yeah." },
  { idx: 879, startMs: 3528892, endMs: 3532712, text: "Did you know you as a believer in Jesus Christ have an enemy?" },
  { idx: 880, startMs: 3534232, endMs: 3537532, text: "If you're a friend of Jesus Christ, you've got an enemy." },
  { idx: 881, startMs: 3538312, endMs: 3538392, text: "Amen." },
  { idx: 882, startMs: 3538472, endMs: 3539832, text: "He is the devil." },
  { idx: 883, startMs: 3540532, endMs: 3542372, text: "He is your adversary." },
  { idx: 884, startMs: 3543292, endMs: 3545712, text: "Not my adversary, your adversary." },
  { idx: 885, startMs: 3546712, endMs: 3549931, text: "Oh, he's mine too, but that's not the emphasis here." },
];
const C4_RANGE = { startMs: 3524472, endMs: 3537532 };

describe("fix M: one look past the end", () => {
  it("shows the clip and the lines that end within 6 seconds after it, numbered from the clip's start", () => {
    const look = endLookLines(ONE_J_C4, C4_RANGE)!;
    expect(look.lines.map((u) => u.idx)).toEqual([877, 878, 879, 880, 881, 882, 883]);
    expect(look).toMatchObject({ end: 3, last: 6 });
    const prompt = endLookPrompt(look.lines, look.end, look.last);
    expect(prompt).toContain("[3] (58:54) If you're a friend of Jesus Christ, you've got an enemy.");
    expect(prompt).toContain("[6] (59:00) He is your adversary.");
    expect(prompt).not.toContain("Not my adversary");
  });

  it("asks only whether the point finishes in the next lines, with neutral examples", () => {
    const look = endLookLines(ONE_J_C4, C4_RANGE)!;
    const prompt = endLookPrompt(look.lines, look.end, look.last);
    expect(prompt).toContain("The clip ends on [3].");
    expect(prompt).toContain("does the clip stop one beat before the preacher finishes this point?");
    expect(prompt).toContain('"There is one thing God cannot do." then "He cannot lie."');
    expect(prompt).toContain("Most clips already end in the right place.");
    expect(prompt).toContain("return the FIRST line that finishes the point, one of [4] to [6], and nothing after it.");
    // The gate is fair only when the prompt holds none of Jake's clips.
    expect(prompt.split("\n\n").slice(0, -1).join(" ")).not.toContain("He is the devil");
  });

  it("moves the end of lab sermon 1j clip 4 to \"He is the devil.\" when the model says the point finishes there", async () => {
    const ask = vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 5, reason: "names the enemy" });
    const result = await lookPastTheEnd(ONE_J_C4, C4_RANGE, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    const look = endLookLines(ONE_J_C4, C4_RANGE)!;
    expect(ask).toHaveBeenCalledWith(endLookPrompt(look.lines, look.end, look.last));
    expect(result.range).toEqual({ startMs: 3524472, endMs: 3539832 });
    expect(result.look).toEqual({ asked: true, movedMs: 2_300, refused: null, reason: "names the enemy", added: "Amen. He is the devil." });
  });

  it("keeps the end when the model says the point is finished", async () => {
    const ask = vi.fn().mockResolvedValue({ finishesLater: false, endUnit: 3, reason: "lands" });
    const result = await lookPastTheEnd(ONE_J_C4, C4_RANGE, ask);
    expect(result.range).toEqual(C4_RANGE);
    expect(result.look).toMatchObject({ asked: true, movedMs: 0, refused: null });
  });

  it("never moves the end earlier, and never past the lines it showed", async () => {
    for (const endUnit of [2, 3, 7]) {
      const ask = vi.fn().mockResolvedValue({ finishesLater: true, endUnit, reason: "x" });
      const result = await lookPastTheEnd(ONE_J_C4, C4_RANGE, ask);
      expect(result.range).toEqual(C4_RANGE);
      expect(result.look.refused).toMatch(/not one of the lines after the end/);
    }
  });

  it("refuses a new end on a line that only leads into a quotation", async () => {
    const units = ONE_J_C4.map((u) => (u.idx === 882 ? { ...u, text: "And Jesus said this to Peter." } : u));
    const result = await lookPastTheEnd(units, C4_RANGE, vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 5, reason: "x" }));
    expect(result.range).toEqual(C4_RANGE);
    expect(result.look.refused).toMatch(/quotation/);
  });

  it("refuses a new end inside a list: lab sermon 4b clip 4's \"We're gonna\" lines", async () => {
    const units = FOUR_B_C4.units;
    const range = { startMs: 2133709, endMs: 2183610 };
    const look = endLookLines(units, range)!;
    expect(look.lines[look.end].text).toMatch(/^We're gonna live/);
    const result = await lookPastTheEnd(units, range, vi.fn().mockResolvedValue({ finishesLater: true, endUnit: look.end + 1, reason: "x" }));
    expect(result.range).toEqual(range);
    expect(result.look.refused).toMatch(/inside a list/);
  });

  it("refuses a new end that makes the clip run past 90 seconds", async () => {
    const units = [{ idx: 800, startMs: 3_449_000, endMs: 3_452_000, text: "This is where the clip starts." }, ...ONE_J_C4];
    const range = { startMs: 3_449_000, endMs: 3537532 };
    const result = await lookPastTheEnd(units, range, vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 6, reason: "x" }));
    expect(result.range).toEqual(range);
    expect(result.look.refused).toMatch(/90 seconds/);
  });

  it("makes no call when no line ends within 6 seconds after the clip", async () => {
    const ask = vi.fn();
    const result = await lookPastTheEnd(ONE_J_C4, { startMs: 3524472, endMs: 3549931 }, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(result.look).toEqual({ asked: false, movedMs: 0, refused: null });
  });
});

// Lab sermon 3i clip 4 (2026-10-22), real lines; the same answers ended 3h clip 6 and 3d clip 5 there.
// Jake failed all three: "I feel like the preacher didn't finish his statement." He passed 3e clip 4
// and 3b clip 2, which end on "That's right." after "2,000 years later."
const THREE_I_C4 = [
  { idx: 1162, startMs: 3477130, endMs: 3478150, text: "Read your New Testament." },
  { idx: 1163, startMs: 3478610, endMs: 3479470, text: "Read the Book of Acts." },
  { idx: 1164, startMs: 3480590, endMs: 3482410, text: "You'll never read where Agrippa got saved." },
  { idx: 1165, startMs: 3482830, endMs: 3483290, text: "That's right." },
  { idx: 1166, startMs: 3483350, endMs: 3483750, text: "That's right." },
  { idx: 1167, startMs: 3484830, endMs: 3485430, text: "Never did." },
  { idx: 1168, startMs: 3487710, endMs: 3488930, text: "I thought about this, Brother Danny." },
  { idx: 1169, startMs: 3491950, endMs: 3498570, text: 'What, what if when Agrippa died and slipped into hell, he began to cry out, "Almost.' },
  { idx: 1170, startMs: 3501890, endMs: 3503030, text: "Almost." },
  { idx: 1171, startMs: 3505690, endMs: 3506870, text: 'Almost."' },
  { idx: 1172, startMs: 3508390, endMs: 3512590, text: "Well, he's still crying it tonight, 2,000 years later." },
  { idx: 1174, startMs: 3512890, endMs: 3513290, text: "That's right." },
  { idx: 1175, startMs: 3514970, endMs: 3521770, text: 'And some of us, when we get to heaven, you\'re not gonna say, "Man, I just spent too much time down there at the church."' },
  { idx: 1177, startMs: 3522270, endMs: 3522410, text: "Yeah." },
  { idx: 1178, startMs: 3522410, endMs: 3525610, text: '"I read my Bible way too much.' },
  { idx: 1179, startMs: 3525670, endMs: 3527090, text: 'I should\'ve watched ESPN more."' },
  { idx: 1180, startMs: 3528410, endMs: 3528570, text: "Right." },
  { idx: 1181, startMs: 3528770, endMs: 3530310, text: '"I should\'ve played video games longer.' },
  { idx: 1182, startMs: 3531370, endMs: 3534170, text: 'I gave way too much money to that church down there at Sunny Lane."' },
  { idx: 1183, startMs: 3534270, endMs: 3534690, text: "That's right." },
  { idx: 1184, startMs: 3534690, endMs: 3538210, text: '"I, I should\'ve kept some of that for myself."' },
  { idx: 1185, startMs: 3539650, endMs: 3542510, text: "No, when we stand before God- Come on." },
];
const THREE_I_C4_RANGE = { startMs: 3477130, endMs: 3521770 };

describe("fix R: a set-up line the clip cannot finish is dropped", () => {
  it("ends lab sermon 3i clip 4 on the line before its set-up when the finishing line is inside a list", async () => {
    // The real answer: "the thought is completed by the ironic lines [14]-[15]".
    const look = endLookLines(THREE_I_C4, THREE_I_C4_RANGE)!;
    expect(look).toMatchObject({ end: 12, last: 15 });
    const ask = vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 15, reason: "sets up the ironic lines" });
    const result = await lookPastTheEnd(THREE_I_C4, THREE_I_C4_RANGE, ask);
    expect(result.range).toEqual({ startMs: 3477130, endMs: 3513290 });
    expect(result.look).toEqual({
      asked: true,
      movedMs: -8_480,
      refused: "Unit [15] is inside a list.",
      reason: "sets up the ironic lines",
      dropped: THREE_I_C4[12].text,
    });
  });

  it("drops the set-up line when the finishing line only leads into a quotation", async () => {
    const units = THREE_I_C4.map((u) => (u.idx === 1177 ? { ...u, text: "And Jesus said this to Peter." } : u));
    const result = await lookPastTheEnd(units, THREE_I_C4_RANGE, vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 13, reason: "x" }));
    expect(result.range).toEqual({ startMs: 3477130, endMs: 3513290 });
    expect(result.look.refused).toMatch(/quotation/);
  });

  it("drops the set-up line when the finishing line makes the clip too long", async () => {
    const result = await lookPastTheEnd(
      THREE_I_C4,
      THREE_I_C4_RANGE,
      vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 13, reason: "x" }),
      45_000,
    );
    expect(result.range).toEqual({ startMs: 3477130, endMs: 3513290 });
    expect(result.look.refused).toMatch(/45 seconds/);
  });

  it("keeps the end when the clip would fall under 15 seconds without its set-up line", async () => {
    const range = { startMs: 3508390, endMs: 3521770 };
    const ask = vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 5, reason: "x" });
    const result = await lookPastTheEnd(THREE_I_C4, range, ask);
    expect(result.range).toEqual(range);
    expect(result.look).toMatchObject({ movedMs: 0, refused: "Unit [5] is inside a list." });
  });

  it("keeps the end when the line before the set-up is a question", async () => {
    const units = THREE_I_C4.map((u) => (u.idx === 1174 ? { ...u, text: "Do you know what he's still crying?" } : u));
    const result = await lookPastTheEnd(units, THREE_I_C4_RANGE, vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 15, reason: "x" }));
    expect(result.range).toEqual(THREE_I_C4_RANGE);
    expect(result.look).toMatchObject({ movedMs: 0, refused: "Unit [15] is inside a list." });
  });

  it("moves back past a line that only leads into a quotation, as the boundary step does", async () => {
    const units = THREE_I_C4.map((u) => (u.idx === 1174 ? { ...u, text: "And he says," } : u));
    const result = await lookPastTheEnd(units, THREE_I_C4_RANGE, vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 15, reason: "x" }));
    expect(result.range).toEqual({ startMs: 3477130, endMs: 3512590 });
    expect(result.look.dropped).toBe(`And he says, ${THREE_I_C4[12].text}`);
  });

  it("keeps the end when the model's answer is not one of the lines shown", async () => {
    const result = await lookPastTheEnd(THREE_I_C4, THREE_I_C4_RANGE, vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 16, reason: "x" }));
    expect(result.range).toEqual(THREE_I_C4_RANGE);
    expect(result.look.refused).toMatch(/not one of the lines after the end/);
  });
});

// Lab sermon 1n clip 6 (2026-10-23), real lines: the foot-washing story. Jake: "It stops in the middle
// of the story." He passed 1l clip 1, from Peter's objection to "wash our feet" (39:28–40:41), and
// failed 1c clip 2 (ended on Peter's objection) and 1d clip 1 (ended before the meaning).
const ONE_N_C6 = [
  { idx: 520, startMs: 2292244, endMs: 2296304, text: "And, and so that is the figure of speech that Peter is using here." },
  { idx: 521, startMs: 2297664, endMs: 2300764, text: "Now, now, why would Simon Peter..." },
  { idx: 522, startMs: 2301224, endMs: 2305704, text: "I mean, why would you think Simon Peter would use that figure of speech?" },
  { idx: 523, startMs: 2306764, endMs: 2308144, text: "I don't think we have to guess." },
  { idx: 524, startMs: 2309184, endMs: 2310284, text: "I believe we know." },
  { idx: 525, startMs: 2311284, endMs: 2319044, text: "Because Simon Peter was there when the Lord Jesus Christ himself had done the exact same thing." },
  { idx: 526, startMs: 2320204, endMs: 2322884, text: "You remember over there in the Gospel of John chapter 13?" },
  { idx: 527, startMs: 2323704, endMs: 2330804, text: "Supper had been ended, and Jesus laid aside his garment, and he took a towel, and he girded himself with it." },
  { idx: 528, startMs: 2331684, endMs: 2336764, text: "The Lord Jesus Christ put on a servant's apron." },
  { idx: 529, startMs: 2337464, endMs: 2344004, text: "Jesus tied on a servant's towel, and then Jesus began to wash the disciples' feet." },
  { idx: 530, startMs: 2345404, endMs: 2347424, text: "And you remember those high and mighty disciples?" },
  { idx: 531, startMs: 2347824, endMs: 2349844, text: "None of them would even think about doing that." },
  { idx: 532, startMs: 2350904, endMs: 2359424, text: "But the Lord Jesus Christ laid aside his garment, took a basin of water, clothed himself with humility," },
  { idx: 533, startMs: 2359984, endMs: 2366284, text: "tied that behind him, that towel, and knelt and washed the disciples' feet." },
  { idx: 534, startMs: 2366624, endMs: 2367864, text: "Amen." },
  { idx: 535, startMs: 2367904, endMs: 2373484, text: 'And when Jesus came to Simon Peter, Simon Peter said, "You\'re not gonna wash my feet."' },
  { idx: 536, startMs: 2374824, endMs: 2379984, text: 'Now, I gotta tell you, if I was there at that time, I would\'ve said, "Peter, you better let him do it, because you\'re about to stick it in your mouth."' },
  { idx: 537, startMs: 2380084, endMs: 2380524, text: "Amen?" },
  { idx: 538, startMs: 2382444, endMs: 2384804, text: '"Oh, no, you\'re not gonna wash my feet, Jesus."' },
  { idx: 539, startMs: 2385184, endMs: 2386604, text: "And Jesus said this to Peter." },
  { idx: 540, startMs: 2386644, endMs: 2391364, text: 'He said, "Now, Peter, if I don\'t wash your feet, you\'ll have no part in me.' },
  { idx: 541, startMs: 2392364, endMs: 2393844, text: 'You\'ll have nothing to do with me."' },
  { idx: 542, startMs: 2394984, endMs: 2398424, text: 'Well, Peter says, "Well, man, if that\'s the case, Lord, wash me all over," right?' },
  { idx: 543, startMs: 2398904, endMs: 2401144, text: '"Not just my feet, but my hands and my head also."' },
  { idx: 544, startMs: 2401984, endMs: 2403124, text: "And this is what Jesus said." },
  { idx: 545, startMs: 2403164, endMs: 2409344, text: 'He said, "Peter, he that had a bath doesn\'t need to be washed except his feet."' },
  { idx: 546, startMs: 2410324, endMs: 2419144, text: "Now, folks, Jesus makes it very clear here that he's doing this as a symbolic act, because that bath referred" },
  { idx: 547, startMs: 2419204, endMs: 2420184, text: "to salvation." },
  { idx: 548, startMs: 2421464, endMs: 2429764, text: "The washing, therefore, of Peter's feet was symbolic of the fact that, that even though we've been saved, we're walking" },
  { idx: 549, startMs: 2429824, endMs: 2430924, text: "in a dirty world." },
  { idx: 550, startMs: 2432084, endMs: 2432104, text: "Amen." },
  { idx: 551, startMs: 2432144, endMs: 2440264, text: "And day by day, we need to come to Jesus, and we need to let him refresh us and restore us and cleanse us and" },
  { idx: 552, startMs: 2440324, endMs: 2441244, text: "wash our feet." },
  { idx: 553, startMs: 2444584, endMs: 2445864, text: "And then Jesus said this." },
  { idx: 554, startMs: 2445924, endMs: 2446704, text: "Now listen to this." },
  { idx: 555, startMs: 2446944, endMs: 2449704, text: "John chapter 13 verse 14, Jesus said this." },
  { idx: 556, startMs: 2450043, endMs: 2458244, text: 'He said, "Peter, if I, your Lord and Teacher, have washed your feet, you also ought to wash one another\'s feet."' },
  { idx: 557, startMs: 2458484, endMs: 2459004, text: "That's right." },
  { idx: 558, startMs: 2459824, endMs: 2459884, text: "Amen." },
  { idx: 559, startMs: 2459944, endMs: 2462104, text: "Now, friend, he's not talking about a church ceremony here." },
];
const ONE_N_C6_RANGE = { startMs: 2311284, endMs: 2366284 };

describe("fix U: the story check", () => {
  const context = boundaryContext(ONE_N_C6, ONE_N_C6_RANGE);
  const abs = (start: string) => context.units.findIndex((u) => u.text.startsWith(start));
  const look = storyLookLines(context.units, ONE_N_C6_RANGE)!;
  const rel = (start: string) => abs(start) - look.offset;
  const story = (landsUnit: number, endIsNarration = true, continues = true, storyStartsUnit = 0, extra: Record<string, unknown> = {}) =>
    vi.fn().mockResolvedValue({ endIsNarration, storyKind: "events", storyStartsUnit, pointStatedUnit: -1, continues, landsUnit, reason: "x", ...extra });
  const boundary = (startUnit: number, endUnit: number) => vi.fn().mockResolvedValue({ startUnit, endUnit, reason: "y" });

  it("shows the clip and up to 25 lines that start within 90 seconds after it, numbered from the clip's start", () => {
    expect(look.lines[0].text).toMatch(/^Because Simon Peter was there/);
    expect(look.lines[look.end].text).toMatch(/^But the Lord Jesus Christ laid aside/);
    expect(look.lines[look.end].text).toMatch(/washed the disciples' feet\.$/);
    expect(look.lines[look.last].text).toMatch(/^He said, "Peter, if I, your Lord/);
    expect(look.last - look.end).toBe(20);
    expect(look.lines.length).toBe(look.last + 1);
  });

  it("asks whether the clip is cut from the middle of a story, with a neutral example", () => {
    const prompt = storyPrompt(look.lines, look.end, look.last);
    expect(prompt).toContain(`The clip ends on [${look.end}].`);
    expect(prompt).toContain("First say whether line [" + look.end + "] itself is narration or dialogue of a story (endIsNarration).");
    expect(prompt).toContain("prodigal son");
    expect(prompt).toContain("Most clips are complete.");
    expect(prompt).toContain(`one of [${look.end + 1}] to [${look.last}]`);
    expect(prompt).toContain(`Return storyStartsUnit: the first line of the clip, [0] to [${look.end}], that narrates the story`);
    expect(prompt).toContain("A list, a chain of reasoning, a verse he reads and explains, or the preacher saying what a Bible writer teaches is not a story.");
    expect(prompt).toContain('Also return storyKind: "events" when the clip tells people and happenings in order');
    expect(prompt).toContain(`pointStatedUnit: the line inside the clip, [0] to [${look.end}], where the preacher states his point about the story`);
    // The gate is fair only when the prompt holds none of Jake's clips.
    expect(prompt.split("\n\n").slice(0, -1).join(" ")).not.toContain("wash my feet");
  });

  it("keeps the range when the model says the clip is complete", async () => {
    const result = await checkStory(context, ONE_N_C6_RANGE, story(-1, true, false), vi.fn());
    expect(result.range).toEqual(ONE_N_C6_RANGE);
    expect(result.check).toMatchObject({ asked: true, continues: false, refused: null });
  });

  it("keeps the range when the model says the story continues but the last line is not narration", async () => {
    const askBoundary = vi.fn();
    const result = await checkStory(context, ONE_N_C6_RANGE, story(rel("And day by day"), false, true), askBoundary);
    expect(result.range).toEqual(ONE_N_C6_RANGE);
    expect(askBoundary).not.toHaveBeenCalled();
  });

  it("cuts the end before a story that begins only in the clip's last seconds, when a second look agrees (fix AB, lab sermon 1q clip 6)", async () => {
    // A clip that ends on "Jesus began to wash the disciples' feet." (6.5 seconds of story) only introduces it:
    // the story is the next clip's, so the end moves to the line before it (gate run: Saul's story in 2b clip 5).
    const range = { startMs: 2311284, endMs: 2344004 };
    const ctx = boundaryContext(ONE_N_C6, range);
    const lk = storyLookLines(ctx.units, range)!;
    const lands = ctx.units.findIndex((u) => u.text.startsWith("And day by day")) - lk.offset;
    const askBoundary = vi.fn();
    const askStory = story(lands, true, true, lk.end);
    const result = await checkStory(ctx, range, askStory, askBoundary);
    expect(askStory).toHaveBeenCalledTimes(2);
    expect(result.range).toEqual({ startMs: range.startMs, endMs: ctx.units[lk.offset + lk.end - 1].endMs });
    expect(result.check).toMatchObject({ outcome: "cut", refused: null, continues: true });
    expect(result.check.movedMs).toBeLessThan(0);
    expect(askBoundary).not.toHaveBeenCalled();
    // The second look must agree that the story starts there.
    const first = { endIsNarration: true, storyKind: "events", storyStartsUnit: lk.end, pointStatedUnit: -1, continues: true, landsUnit: lands, reason: "first" };
    const disagree = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first, storyStartsUnit: 0, reason: "second" });
    const keptRange = await checkStory(ctx, range, disagree, askBoundary);
    expect(keptRange.range).toEqual(range);
    expect(keptRange.check.refused).toMatch(/fills less than 12 seconds of the clip.*second look did not agree/);
    const none = await checkStory(ctx, range, story(lands, true, true, -1), askBoundary);
    expect(none.range).toEqual(range);
    expect(none.check.refused).toMatch(/fills less than 12 seconds of the clip/);
    // From the clip's first line the story fills the whole clip, and the check goes on to the landing.
    const whole = await checkStory(ctx, range, story(lands, true, true, 0), vi.fn().mockResolvedValue({ startUnit: 0, endUnit: 0, reason: "y" }));
    expect(whole.check.refused).not.toMatch(/fills less than/);
  });

  it("keeps the range when what the clip tells is not a story of events (gate run: Paul's blessings, lab sermon 5e clip 4)", async () => {
    for (const storyKind of ["list", "teaching", "verse", "none"]) {
      const askBoundary = vi.fn();
      const result = await checkStory(context, ONE_N_C6_RANGE, story(rel("And day by day"), true, true, 0, { storyKind }), askBoundary);
      expect(result.range).toEqual(ONE_N_C6_RANGE);
      expect(result.check.refused).toMatch(/not a story/);
      expect(askBoundary).not.toHaveBeenCalled();
    }
  });

  it("keeps the range when the clip already states the preacher's point about the story (gate run: lab sermon 4g clip 5)", async () => {
    const result = await checkStory(context, ONE_N_C6_RANGE, story(rel("And day by day"), true, true, 0, { pointStatedUnit: 0 }), vi.fn());
    expect(result.range).toEqual(ONE_N_C6_RANGE);
    expect(result.check.refused).toBe("The clip states the preacher's point about the story at [0].");
  });

  it("makes no call when the lines after the clip read a verse (gate run: Saul's story, lab sermon 2b clip 5)", async () => {
    const units = ONE_N_C6.map((u) => (u.idx === 535 ? { ...u, text: "Look at what the Bible says in verse three." } : u));
    expect(readsVerseNext(wholeSentences(units), wholeSentences(units).findIndex((u) => u.idx === 532))).toBe(true);
    expect(readsVerseNext(wholeSentences(ONE_N_C6), wholeSentences(ONE_N_C6).findIndex((u) => u.idx === 532))).toBe(false);
    const askStory = vi.fn();
    const result = await checkStory(boundaryContext(units, ONE_N_C6_RANGE), ONE_N_C6_RANGE, askStory, vi.fn());
    expect(askStory).not.toHaveBeenCalled();
    expect(result.range).toEqual(ONE_N_C6_RANGE);
    expect(result.check).toEqual({ asked: false, continues: false, landsMs: null, refused: "The lines after the clip read a verse." });
  });

  it("asks a second time and keeps the range when the second look does not agree (gate runs: 2j clip 1, 5f clip 5)", async () => {
    const agree = { endIsNarration: true, storyKind: "events", storyStartsUnit: 0, pointStatedUnit: -1, continues: true, landsUnit: rel("And day by day"), reason: "first" };
    const askStory = vi.fn().mockResolvedValueOnce(agree).mockResolvedValueOnce({ ...agree, continues: false, landsUnit: -1, reason: "second" });
    const askBoundary = vi.fn();
    const result = await checkStory(context, ONE_N_C6_RANGE, askStory, askBoundary);
    expect(askStory).toHaveBeenCalledTimes(2);
    expect(result.range).toEqual(ONE_N_C6_RANGE);
    expect(result.check).toMatchObject({ refused: "A second look did not agree that the story continues.", reason: "first", secondReason: "second" });
    expect(askBoundary).not.toHaveBeenCalled();
    // When both agree, the later of the two landings is used.
    const earlier = { ...agree, landsUnit: rel("Now, folks, Jesus makes it very clear") };
    const both = vi.fn().mockResolvedValueOnce(earlier).mockResolvedValueOnce(agree);
    const moved = await checkStory(context, ONE_N_C6_RANGE, both, boundary(abs("And when Jesus came to Simon Peter"), abs("And day by day")));
    expect(moved.check).toMatchObject({ landsMs: 2441244, outcome: "restarted" });
  });

  it("never lands on a verse he reads after the story (gate run 4: John 13:14), and takes the other look's landing", async () => {
    const agree = { endIsNarration: true, storyKind: "events", storyStartsUnit: 0, pointStatedUnit: -1, continues: true, landsUnit: rel("And day by day"), reason: "a" };
    const verse = { ...agree, landsUnit: rel('He said, "Peter, if I, your Lord'), reason: "b" };
    const askStory = vi.fn().mockResolvedValueOnce(agree).mockResolvedValueOnce(verse);
    const result = await checkStory(context, ONE_N_C6_RANGE, askStory, boundary(abs("And when Jesus came to Simon Peter"), abs("And day by day")));
    expect(result.check).toMatchObject({ landsMs: 2441244, outcome: "restarted" });
    const both = vi.fn().mockResolvedValue(verse);
    const kept = await checkStory(context, ONE_N_C6_RANGE, both, vi.fn());
    expect(kept.range).toEqual(ONE_N_C6_RANGE);
    expect(kept.check.refused).toBe("The landing is a verse he reads after the story.");
  });

  it("makes one call when the first look says the clip is complete", async () => {
    const askStory = story(-1, true, false);
    await checkStory(context, ONE_N_C6_RANGE, askStory, vi.fn());
    expect(askStory).toHaveBeenCalledTimes(1);
  });

  it("restarts lab sermon 1n clip 6 later in the story when the landing makes it too long: Jake's 1l clip 1", async () => {
    const landing = abs("And day by day");
    const askBoundary = boundary(abs("And when Jesus came to Simon Peter"), landing);
    const result = await checkStory(context, ONE_N_C6_RANGE, story(rel("And day by day")), askBoundary);
    expect(result.range).toEqual({ startMs: 2367904, endMs: 2441244 });
    expect(result.check).toMatchObject({ asked: true, continues: true, landsMs: 2441244, refused: null, outcome: "restarted", movedMs: 74_960 });
    expect(result.attempts).toHaveLength(1);
    // The boundary step is told to hold that end and start later.
    const firstTurn = askBoundary.mock.calls[0][0][0].content as string;
    expect(firstTurn).toContain(`Hold the end: The story this clip is inside lands at unit [${landing}] (40:32): "And day by day`);
    expect(firstTurn).toContain(`Keep the end at unit [${landing}], or within 8 seconds of it, and start later, so the clip runs 75 seconds at most`);
  });

  it("refuses a restart that ends well before the landing, with the hold as the reason", async () => {
    const landing = abs("And day by day");
    const early = abs('He said, "Peter, he that had a bath');
    const askBoundary = vi.fn().mockResolvedValue({ startUnit: abs("And when Jesus came to Simon Peter"), endUnit: early, reason: "y" });
    const result = await checkStory(context, ONE_N_C6_RANGE, story(rel("And day by day")), askBoundary);
    expect(result.range).toEqual(ONE_N_C6_RANGE);
    expect(result.check).toMatchObject({ outcome: "unresolved" });
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts![0].refused).toContain(`The story this clip is inside lands at unit [${landing}]`);
    expect(result.attempts![0].refused).toContain(`Keep the end at unit [${landing}] or later, and start later.`);
  });

  it("extends the end to the landing when the clip stays within 90 seconds: lab sermon 1d clip 1", async () => {
    const range = { startMs: 2367904, endMs: 2409344 };
    const ctx = boundaryContext(ONE_N_C6, range);
    const lk = storyLookLines(ctx.units, range)!;
    const lands = ctx.units.findIndex((u) => u.text.startsWith("And day by day")) - lk.offset;
    const askBoundary = vi.fn();
    const result = await checkStory(ctx, range, story(lands), askBoundary);
    expect(result.range).toEqual({ startMs: 2367904, endMs: 2441244 });
    expect(result.check).toMatchObject({ outcome: "extended", movedMs: 31_900, landsMs: 2441244 });
    expect(askBoundary).not.toHaveBeenCalled();
  });

  it("keeps the range when the story does not land within the lines shown", async () => {
    const result = await checkStory(context, ONE_N_C6_RANGE, story(-1), vi.fn());
    expect(result.range).toEqual(ONE_N_C6_RANGE);
    expect(result.check).toMatchObject({ outcome: "unresolved", refused: "The story does not land within the lines shown." });
  });

  it("refuses a landing that is not one of the lines after the end", async () => {
    for (const landsUnit of [0, look.end, look.last + 1]) {
      const result = await checkStory(context, ONE_N_C6_RANGE, story(landsUnit), vi.fn());
      expect(result.range).toEqual(ONE_N_C6_RANGE);
      expect(result.check.refused).toMatch(/not one of the lines after the end/);
    }
  });

  it("makes no call when no line starts within 90 seconds after the clip", async () => {
    const askStory = vi.fn();
    const result = await checkStory(context, { startMs: 2311284, endMs: 2462104 }, askStory, vi.fn());
    expect(askStory).not.toHaveBeenCalled();
    expect(result.check).toEqual({ asked: false, continues: false, landsMs: null, refused: null });
  });
});

// Lab sermon 1n clip 2 (2026-10-23), real lines. The clip ended on "So God's grace gonna make you fit.",
// which recaps point one right before "But number two". Jake: 'it would be better if it ended on, "Jesus
// can heal you today. Hallelujah."' The same clip failed in 1d with the same note and passed in 1g.
const ONE_N_C2 = [
  { idx: 1054, startMs: 4110300, endMs: 4113060, text: "His grace will do that for you today." },
  { idx: 1055, startMs: 4113260, endMs: 4113620, text: "Yeah." },
  { idx: 1056, startMs: 4113680, endMs: 4115100, text: "You've gotten bent out of shape." },
  { idx: 1057, startMs: 4115440, endMs: 4116960, text: "You've gotten away from the Lord." },
  { idx: 1058, startMs: 4117600, endMs: 4118600, text: "Sin in your life." },
  { idx: 1059, startMs: 4119180, endMs: 4120080, text: "You've failed Him." },
  { idx: 1060, startMs: 4120440, endMs: 4121420, text: "You've gone down." },
  { idx: 1061, startMs: 4121940, endMs: 4123220, text: "You've disappointed Him." },
  { idx: 1062, startMs: 4123780, endMs: 4124360, text: "Guess what?" },
  { idx: 1063, startMs: 4124740, endMs: 4127280, text: "He will mend your net." },
  { idx: 1064, startMs: 4127760, endMs: 4130560, text: "He will tie up all those loose ends." },
  { idx: 1065, startMs: 4130860, endMs: 4134080, text: "He will set that bone straight again." },
  { idx: 1066, startMs: 4134560, endMs: 4134600, text: "Amen." },
  { idx: 1067, startMs: 4134660, endMs: 4136980, text: "Jesus can heal you today." },
  { idx: 1068, startMs: 4137180, endMs: 4137580, text: "Hallelujah." },
  { idx: 1069, startMs: 4137640, endMs: 4138500, text: "That's what He can do." },
  { idx: 1070, startMs: 4140920, endMs: 4143760, text: "So God's grace gonna make you fit." },
  { idx: 1071, startMs: 4144520, endMs: 4147440, text: "But number two, God's grace can make you firm." },
  { idx: 1072, startMs: 4148340, endMs: 4149559, text: "Not just fit, but firm." },
  { idx: 1073, startMs: 4150080, endMs: 4151320, text: "Look at it again in verse 10." },
];

describe("fix T: no end on a recap that leads into the next numbered point", () => {
  const units = wholeSentences(ONE_N_C2);
  const recap = units.findIndex((u) => u.text.startsWith("So God's grace"));

  it("finds the recap before \"But number two\", and nothing else", () => {
    expect(endsOnRecapIntoNextPoint(units, recap)).toBe(true);
    expect(endsOnRecapIntoNextPoint(units, recap - 1)).toBe(false);
    expect(endsOnRecapIntoNextPoint(units, recap + 1)).toBe(false);
    const plainNext = units.map((u, i) => (i === recap + 1 ? { ...u, text: "And God's grace can make you firm." } : u));
    expect(endsOnRecapIntoNextPoint(plainNext, recap)).toBe(false);
    const noRecap = units.map((u, i) => (i === recap ? { ...u, text: "God's grace gonna make you fit." } : u));
    expect(endsOnRecapIntoNextPoint(noRecap, recap)).toBe(false);
    expect(endsOnRecapIntoNextPoint(units, units.length - 1)).toBe(false);
  });

  it("reads later points in other words: \"There's a third certainty\", \"Secondly\"", () => {
    for (const next of ["There's a third certainty I want you to see.", "Secondly, you need to resist him.", "Truth number two, y'all still with me?"]) {
      const changed = units.map((u, i) => (i === recap + 1 ? { ...u, text: next } : u));
      expect(endsOnRecapIntoNextPoint(changed, recap)).toBe(true);
    }
  });

  it("steps lab sermon 1n clip 2's end back onto \"That's what He can do.\"", () => {
    const context = boundaryContext(ONE_N_C2, { startMs: 4110300, endMs: 4143760 });
    const start = context.units.findIndex((u) => u.text.startsWith("His grace will do that"));
    const end = context.units.findIndex((u) => u.text.startsWith("So God's grace"));
    expect(applyBoundaryChoice(context, { startUnit: start, endUnit: end })).toEqual({
      startMs: 4110300,
      endMs: 4138500,
      adjustedForScripture: false,
      adjustedStart: false,
      adjustedEnd: true,
    });
  });

  it("does not let the end look move the end onto the recap", async () => {
    const range = { startMs: 4110300, endMs: 4138500 };
    const look = endLookLines(units, range)!;
    expect(look.lines[look.end + 1].text).toMatch(/^So God's grace/);
    const result = await lookPastTheEnd(units, range, vi.fn().mockResolvedValue({ finishesLater: true, endUnit: look.end + 1, reason: "x" }));
    expect(result.range).toEqual(range);
    expect(result.look.refused).toBe(`Unit [${look.end + 1}] recaps the point and leads into the next numbered point.`);
  });
});

// Lab sermon 5g clip 4 (2026-10-25), real lines. The clip ended on "Revival is an experience for God's
// people." Jake: "I don't think he finished his point completely." The point runs on through six more
// parallel lines to "of our Lord and Savior, Jesus Christ."
const FIVE_G_C4 = boundaryContext(
  [
    { idx: 386, startMs: 1712656, endMs: 1712756, text: "Amen." },
    { idx: 387, startMs: 1712816, endMs: 1720236, text: "Sometimes people get confused about revival, 'cause revival is not for lost people." },
    { idx: 388, startMs: 1720756, endMs: 1723676, text: "See, only the vived can be revived." },
    { idx: 389, startMs: 1723736, endMs: 1723836, text: "Yep." },
    { idx: 390, startMs: 1724156, endMs: 1729176, text: "If you've never been saved, you don't need revival, but you need a resurrection- Yeah ..." },
    { idx: 391, startMs: 1729176, endMs: 1734156, text: "because the Bible says the lost are dead in trespasses and sin." },
    { idx: 392, startMs: 1734216, endMs: 1734356, text: "That's right." },
    { idx: 393, startMs: 1734756, endMs: 1737256, text: "Revival is an experience for the church." },
    { idx: 394, startMs: 1737756, endMs: 1740316, text: "Revival is an experience for God's people." },
    { idx: 395, startMs: 1740816, endMs: 1743516, text: "It is a renewal in the body of Christ." },
    { idx: 396, startMs: 1743556, endMs: 1743636, text: "Yeah." },
    { idx: 397, startMs: 1743956, endMs: 1747796, text: "It is a spiritual awakening among the people of God." },
    { idx: 398, startMs: 1748216, endMs: 1752336, text: "And in times of revival, people's hearts are warmed." },
    { idx: 399, startMs: 1752856, endMs: 1756896, text: "In times of revival, God's people are drawn closer to the Lord." },
    { idx: 400, startMs: 1757376, endMs: 1762956, text: "In times of revival, our vision is expanded, our faith is deepened." },
    { idx: 401, startMs: 1763476, endMs: 1771696, text: "In times of revival, the very atmosphere of the church is literally electrified by the manifest presence- Yes" },
    { idx: 402, startMs: 1771736, endMs: 1771836, text: "..." },
    { idx: 403, startMs: 1771836, endMs: 1774596, text: "of our Lord and Savior, Jesus Christ." },
    { idx: 404, startMs: 1774616, endMs: 1774716, text: "Right." },
    { idx: 405, startMs: 1775116, endMs: 1775196, text: "Amen." },
    { idx: 406, startMs: 1775196, endMs: 1779036, text: 'Now, some people say, "You know, revival\'s a bunch of emotionalism.' },
    { idx: 407, startMs: 1780316, endMs: 1782056, text: 'You know, revivals don\'t last."' },
    { idx: 408, startMs: 1782096, endMs: 1785716, text: "And I just say to the skeptics, neither does deodorant, but it sure helps." },
    { idx: 409, startMs: 1786216, endMs: 1787796, text: "And if a revival- Amen ..." },
    { idx: 410, startMs: 1787796, endMs: 1791636, text: "doesn't last but a couple of hours, I don't think it's gonna hurt anything in the church." },
    { idx: 411, startMs: 1791716, endMs: 1791796, text: "Yeah." },
    { idx: 412, startMs: 1792176, endMs: 1792196, text: "Amen." },
  ],
  { startMs: 1712816, endMs: 1740316 },
  90_000,
);
const at5g = (idx: number) => FIVE_G_C4.units.findIndex((u) => u.idx === idx);

// Lab sermon 1f clip 5 (passed), real lines: three pairs of parallel lines, no run of three.
const ONE_F_C5 = wholeSentences([
  { idx: 956, startMs: 3687740, endMs: 3693240, text: "But friend, lurking behind the next bush is your adversary, the Devil." },
  { idx: 957, startMs: 3694880, endMs: 3694960, text: "Amen." },
  { idx: 958, startMs: 3694960, endMs: 3703440, text: "And he's gonna pounce on you, and he's gonna swallow you down so quick that you won't even recognize it, because" },
  { idx: 959, startMs: 3703480, endMs: 3704700, text: "he's setting you up." },
  { idx: 960, startMs: 3706040, endMs: 3706780, text: "Be sober." },
  { idx: 961, startMs: 3707040, endMs: 3707800, text: "Be vigilant." },
  { idx: 962, startMs: 3708680, endMs: 3712380, text: "He's gonna swallow you up because you haven't been watching." },
  { idx: 963, startMs: 3713720, endMs: 3714820, text: "You haven't been praying." },
  { idx: 964, startMs: 3716220, endMs: 3717320, text: "You haven't been sober." },
  { idx: 965, startMs: 3718440, endMs: 3719820, text: "You haven't been in the Word." },
  { idx: 966, startMs: 3721160, endMs: 3725000, text: "You haven't been vigilant, and you think you're gonna make it?" },
  { idx: 967, startMs: 3726440, endMs: 3727140, text: "You will not." },
  { idx: 968, startMs: 3728020, endMs: 3728560, text: "You will not." },
  { idx: 969, startMs: 3730560, endMs: 3734760, text: "Simon Peter knew, and you're not any better a man than he was." },
  { idx: 970, startMs: 3735960, endMs: 3743540, text: "Simon Peter went down, and so will you if you don't do what Simon Peter says to do today." },
  { idx: 971, startMs: 3744120, endMs: 3747060, text: "Be sober, be vigilant, and watch." },
]);
const at1f5 = (idx: number) => ONE_F_C5.findIndex((u) => u.idx === idx);

describe("fix W: no end inside a block of parallel lines", () => {
  it('runs an open sentence through a "..." segment instead of closing it there', () => {
    const unit = FIVE_G_C4.units[at5g(401)];
    expect(unit.text).toBe(
      "In times of revival, the very atmosphere of the church is literally electrified by the manifest presence- Yes ... of our Lord and Savior, Jesus Christ.",
    );
    expect(unit.endMs).toBe(1774596);
    expect(at5g(402)).toBe(-1);
    expect(at5g(403)).toBe(-1);
  });

  it('drops a "..." segment that follows a closed sentence', () => {
    const units = wholeSentences([
      { idx: 1, startMs: 0, endMs: 1_000, text: "Amen." },
      { idx: 2, startMs: 1_000, endMs: 1_100, text: "..." },
      { idx: 3, startMs: 1_100, endMs: 2_000, text: "Now listen." },
    ]);
    expect(units.map((u) => u.text)).toEqual(["Amen.", "Now listen."]);
  });

  it('finds the block: "Revival is" twice, "It is" twice, "In times" four times, and where it ends', () => {
    expect(endsInsideParallelBlock(FIVE_G_C4.units, at5g(394))).toEqual({
      first: at5g(393),
      last: at5g(401),
      openings: ["Revival is", "It is", "in times"],
    });
    expect(endsInsideParallelBlock(FIVE_G_C4.units, at5g(397))).toMatchObject({ last: at5g(401) });
    expect(endsInsideParallelBlock(FIVE_G_C4.units, at5g(399))).toMatchObject({ last: at5g(401) });
  });

  it("accepts an end on the block's last line, after it, or before it", () => {
    expect(endsInsideParallelBlock(FIVE_G_C4.units, at5g(401))).toBeNull();
    expect(endsInsideParallelBlock(FIVE_G_C4.units, at5g(408))).toBeNull();
    expect(endsInsideParallelBlock(FIVE_G_C4.units, at5g(391))).toBeNull();
  });

  it("refuses Jake's failed end and says where the block ends; accepts the block's last line", () => {
    const refusal = boundaryRefusal(FIVE_G_C4, { startUnit: at5g(387), endUnit: at5g(394) });
    expect(refusal).toContain(`is inside a run of parallel lines: units [${at5g(393)}] to [${at5g(401)}] open with "Revival is", "It is", "in times"`);
    expect(refusal).toContain(`End after its last line, unit [${at5g(401)}]`);
    expect(applyBoundaryChoice(FIVE_G_C4, { startUnit: at5g(387), endUnit: at5g(401) })).toMatchObject({ startMs: 1712816, endMs: 1774596 });
  });

  it("needs one run of three or more: lab sermon 1f clip 5's three pairs are not a block (passed)", () => {
    expect(endsInsideParallelBlock(ONE_F_C5, at1f5(968))).toBeNull();
    expect(endsInsideParallelBlock(ONE_F_C5, at1f5(962))).toBeNull();
    expect(endsInsideParallelBlock(ONE_F_C5, at1f5(965))).toBeNull();
  });

  it("chains runs across a full line, but an end on that line is not inside: lab sermon 4b clips 1 and 4", () => {
    // "And everywhere God speaks, it is absolute truth." sits between the "That's why" pair and the "What God says"
    // list. Jake's end is right after it, on "Amen."; an end on the pair's last line is inside.
    expect(endsInsideParallelBlock(FOUR_B_C1.units, at1(769))).toBeNull();
    expect(endsInsideParallelBlock(FOUR_B_C1.units, at1(768))).toBeNull();
    expect(endsInsideParallelBlock(FOUR_B_C1.units, at1(767))).toEqual({ first: at1(766), last: at1(777), openings: ["That's why", "What God"] });
    expect(applyBoundaryChoice(FOUR_B_C1, { startUnit: at1(758), endUnit: at1(769) })).toMatchObject({ endMs: 3397886 });
    expect(endsInsideParallelBlock(FOUR_B_C4.units, at4(466))).toEqual({ first: at4(465), last: at4(471), openings: ["I want", "We're gonna"] });
    expect(endsInsideParallelBlock(FOUR_B_C4.units, at4(467))).toBeNull();
    expect(endsInsideParallelBlock(FOUR_B_C4.units, at4(471))).toBeNull();
  });

  it("counts a call-out right after a line of the block as an end on that line", () => {
    expect(endsInsideParallelBlock(FIVE_G_C4.units, at5g(396))).toMatchObject({ last: at5g(401) });
  });

  it("refuses a new end from the look past the end when it is inside the block", async () => {
    const range = { startMs: 1712816, endMs: 1737256 };
    const look = endLookLines(FIVE_G_C4.units, range)!;
    expect(look.lines[look.end].text).toBe("Revival is an experience for the church.");
    const result = await lookPastTheEnd(FIVE_G_C4.units, range, vi.fn().mockResolvedValue({ finishesLater: true, endUnit: look.end + 1, reason: "x" }));
    expect(result.look.refused).toMatch(/inside a run of parallel lines/);
    expect(result.range.endMs).toBeLessThanOrEqual(range.endMs);
  });
});

// Lab sermon 4i clip 6 (2026-10-25), real lines. The clip ended on the verse 13 quote. Jake: "he doesn't
// end with a powerfull statment about the scripture he read, it's just the last verse. The clips should
// always start and end with a powerful statement / commentary." He passed 4d clip 4, 32:03 to 33:28.
const FOUR_I_C6 = boundaryContext(
  [
    { idx: 413, startMs: 1923230, endMs: 1930490, text: "First of all, I want you to know that it is for certain that Christians never die." },
    { idx: 414, startMs: 1931870, endMs: 1931950, text: "Amen." },
    { idx: 415, startMs: 1931950, endMs: 1935750, text: "It is for certain that Christians never die." },
    { idx: 416, startMs: 1935970, endMs: 1944370, text: "Look, the Bible says that our understanding at what happens at death is not based on human speculation, but divine revelation." },
    { idx: 417, startMs: 1944930, endMs: 1952750, text: 'In fact, the Bible says in verse 12, Simon Peter says, "It is presented and it stands on the truth of God\'s word."' },
    { idx: 418, startMs: 1953370, endMs: 1961570, text: 'He says in verse 12, "For this reason I will not be negligent to remind you always of these things, though you know and are established in' },
    { idx: 419, startMs: 1961630, endMs: 1962970, text: 'the present truth."' },
    { idx: 420, startMs: 1963650, endMs: 1967950, text: "And then in verse 13, Simon Peter says that his body is a tent." },
    { idx: 421, startMs: 1968590, endMs: 1976690, text: 'He says there, "Yes, I think it is right as long as I am in this tent to stir you up by reminding you of this' },
    { idx: 422, startMs: 1976750, endMs: 1977110, text: 'truth."' },
    { idx: 423, startMs: 1978390, endMs: 1984230, text: "You, you see, sometimes we remember the truth, but we forget the application of the truth." },
    { idx: 424, startMs: 1985230, endMs: 1992430, text: "And we're living in a generation of people that are living in fear because of wars and rumors of wars." },
    { idx: 425, startMs: 1993370, endMs: 2000910, text: "It, it seems that there is violence on every hand, wh- whether it's in the world at large or in our communities." },
    { idx: 426, startMs: 2001669, endMs: 2008230, text: "A- and yet, here is a word that can help us face the uncertainties in life with confidence." },
    { idx: 427, startMs: 2009070, endMs: 2018750, text: 'He says there in verse 13, "Yes, I think it is right as long as I am in this tent to stir you up by reminding you," I\'m gonna give you this truth, "knowing' },
  ],
  { startMs: 1923230, endMs: 1977110 },
  90_000,
);
const at4i = (idx: number) => FOUR_I_C6.units.findIndex((u) => u.idx === idx);

describe("fix X: no end on a verse reading", () => {
  it("knows the lines that read or quote a verse", () => {
    expect(readsVerse(FOUR_I_C6.units, at4i(417))).toBe(true);
    expect(readsVerse(FOUR_I_C6.units, at4i(418))).toBe(true);
    // The quote after "And then in verse 13, Simon Peter says that his body is a tent."
    expect(readsVerse(FOUR_I_C6.units, at4i(421))).toBe(true);
    expect(readsVerse(FOUR_I_C6.units, at4i(416))).toBe(false);
    expect(readsVerse(FOUR_I_C6.units, at4i(420))).toBe(false);
    expect(readsVerse(FOUR_I_C6.units, at4i(423))).toBe(false);
  });

  it("keeps a quoted punch line that names no verse, and refuses one right after a named verse", () => {
    const punch = [
      { idx: 1, startMs: 0, endMs: 2_000, text: "Listen to me today." },
      { idx: 2, startMs: 2_000, endMs: 5_000, text: 'Jesus said, "Ask and you shall receive."' },
    ];
    expect(readsVerse(punch, 1)).toBe(false);
    const named = [
      { idx: 1, startMs: 0, endMs: 2_000, text: "Turn with me to Matthew 7." },
      { idx: 2, startMs: 2_000, endMs: 5_000, text: 'He said, "Ask and you shall receive."' },
    ];
    expect(readsVerse(named, 1)).toBe(true);
  });

  it("refuses Jake's failed end and says to end where the preacher says what it means; accepts the application", () => {
    const refusal = boundaryRefusal(FOUR_I_C6, { startUnit: at4i(413), endUnit: at4i(421) });
    expect(refusal).toContain(`Unit [${at4i(421)}] reads the Scripture`);
    expect(refusal).toMatch(/says what it means/);
    expect(applyBoundaryChoice(FOUR_I_C6, { startUnit: at4i(413), endUnit: at4i(426) })).toMatchObject({ startMs: 1923230, endMs: 2008230 });
  });

  it("the look past the end never saw the application line: it ends 7.1 seconds after the cut", () => {
    // The boundary rule, not the look, moves this clip: the window stays at 6 seconds (see END_LOOK_MAX_MS).
    expect(endLookLines(FOUR_I_C6.units, { startMs: 1923230, endMs: 1977110 })).toBeNull();
  });

  it("refuses the look's answer when it is a verse line, and does not drop the clip's last line for it", async () => {
    const units = [
      { idx: 1, startMs: 0, endMs: 4_000, text: "God keeps every promise He makes." },
      { idx: 2, startMs: 4_100, endMs: 6_000, text: "Turn with me to Matthew 7." },
      { idx: 3, startMs: 6_100, endMs: 9_000, text: 'He said, "Ask and you shall receive."' },
      { idx: 4, startMs: 9_100, endMs: 11_000, text: "That is the promise." },
    ];
    const range = { startMs: 0, endMs: 4_000 };
    const result = await lookPastTheEnd(units, range, vi.fn().mockResolvedValue({ finishesLater: true, endUnit: 2, reason: "x" }));
    expect(result.range).toEqual(range);
    expect(result.look.refused).toMatch(/reads the Scripture/);
    expect(result.look.dropped).toBeUndefined();
  });
});

// Fix Z (2026-10-25). Real lines from lab sermon 1p around clip 4's end (56:26–57:10). The recap before
// "But then the third thing" runs two lines. Jake: 'should have ended at "He cares for you. He cares for
// you. He loves you. He loves you."'
const ONE_P_C4_END: BoundaryUnit[] = [
  { idx: 760, startMs: 3386530, endMs: 3390350, text: "You're being misused, you're being abused, some of you are feeling beat up." },
  { idx: 761, startMs: 3390810, endMs: 3393990, text: "Cast your burden upon the Lord." },
  { idx: 762, startMs: 3394510, endMs: 3397850, text: "Cast your burden upon the Lord." },
  { idx: 763, startMs: 3398270, endMs: 3401930, text: "Cast your burden upon the Lord." },
  { idx: 764, startMs: 3402210, endMs: 3404690, text: "He cares for you." },
  { idx: 765, startMs: 3405110, endMs: 3408930, text: "He cares for you." },
  { idx: 766, startMs: 3409450, endMs: 3410370, text: "He loves you." },
  { idx: 767, startMs: 3410870, endMs: 3411670, text: "He loves you." },
  { idx: 768, startMs: 3414110, endMs: 3417390, text: "So, so there must be this spirit of servitude." },
  { idx: 769, startMs: 3418070, endMs: 3423590, text: "There must be this spirit of serenity as you cast your troubles upon the Lord and He cares for you." },
  { idx: 770, startMs: 3424070, endMs: 3428650, text: "But then the third thing that you need to put in this kit is a spirit of sobriety." },
  { idx: 771, startMs: 3429690, endMs: 3430310, text: "Sobriety." },
];

describe("fix Z: the recap before the next point may run two lines (lab sermon 1p clip 4)", () => {
  const units = ONE_P_C4_END;
  const so = units.findIndex((u) => u.text.startsWith("So, so there must"));

  it("finds both recap lines before \"But then the third thing\"", () => {
    expect(recapIntoNextPoint(units, so + 1)).toEqual({ first: so });
    expect(endsOnRecapIntoNextPoint(units, so + 1)).toBe(true);
    // The line after the "So" line is the recap's second line, not the next point.
    expect(recapIntoNextPoint(units, so)).toBeNull();
    expect(recapIntoNextPoint(units, so - 1)).toBeNull();
    expect(recapIntoNextPoint(units, units.length - 1)).toBeNull();
  });

  it("needs the same opening words on the earlier line", () => {
    const changed = units.map((u, i) => (i === so ? { ...u, text: "So cast it on Him and leave it there." } : u));
    expect(recapIntoNextPoint(changed, so + 1)).toBeNull();
  });

  it("still finds a one-line recap (fix T, lab sermon 1n clip 2)", () => {
    const oneLine = units.filter((_, i) => i !== so);
    const recap = oneLine.findIndex((u) => u.text.startsWith("There must be this spirit of serenity"));
    expect(recapIntoNextPoint(oneLine, recap)).toBeNull(); // no "So": not a recap
    const withSo = oneLine.map((u, i) => (i === recap ? { ...u, text: "So there must be this spirit of serenity." } : u));
    expect(recapIntoNextPoint(withSo, recap)).toEqual({ first: recap });
  });

  it("moves lab sermon 1p clip 4's end back onto the second \"He loves you.\"", () => {
    const context = boundaryContext(units, { startMs: units[0].startMs, endMs: units[so + 1].endMs });
    expect(applyBoundaryChoice(context, { startUnit: 0, endUnit: so + 1 })).toEqual({
      startMs: units[0].startMs,
      endMs: units[so - 1].endMs,
      adjustedForScripture: false,
      adjustedStart: false,
      adjustedEnd: true,
    });
  });
});

describe("fix Z: the prompts start on the hook, end on the strongest line, and prefer the shorter clip", () => {
  const prompt = boundaryPrompt(boundaryContext(CLIP5, { startMs: 3455184, endMs: 3522400 }, 90_000));

  it("tells the model to start on the hook and skip the lead-in", () => {
    expect(prompt).toContain("Start on the hook: the first line that would stop a viewer scrolling.");
    expect(prompt).toContain("Look for the hook in the first 35 seconds of the current clip.");
    expect(prompt).toContain("skip the lines that lead into the hook, even when they introduce the theme");
    expect(prompt).toContain("Never move the start later than that to hunt for a hook");
    expect(prompt).toContain("start on the hook, not on the announcement.");
    expect(prompt).not.toContain("the first sentence a viewer with no context needs");
  });

  it("tells the model to stop on the punch line and to prefer the shorter clip", () => {
    expect(prompt).toContain("End on the strongest line, not on the last related line.");
    expect(prompt).toContain("Go past 60 only when the point cannot land sooner");
    expect(prompt).toContain("A later start on the hook and an earlier end on the punch line both shorten the clip");
  });

  it("tells the end look never to move past a punch line", () => {
    const look = endLookLines(ONE_P_C4_END, { startMs: ONE_P_C4_END[0].startMs, endMs: ONE_P_C4_END[6].endMs });
    expect(look).not.toBeNull();
    expect(endLookPrompt(look!.lines, look!.end, look!.last)).toContain(
      "Never move past a line like that to add a supporting verse, a reason, or a restatement of it",
    );
  });

  it("lets the lab's control run pass the prompts as they were", async () => {
    const units = ONE_P_C4_END;
    const context = boundaryContext(units, { startMs: units[0].startMs, endMs: units[7].endMs });
    const ask = vi.fn(async () => ({ startUnit: 0, endUnit: 7, reason: "test" }));
    const chosen = await chooseBoundary(context, ask, undefined, null, () => "CUSTOM BOUNDARY PROMPT");
    expect(ask).toHaveBeenCalledWith([{ role: "user", content: "CUSTOM BOUNDARY PROMPT" }]);
    expect(chosen.range).toMatchObject({ startMs: units[0].startMs, endMs: units[7].endMs });
    const askLook = vi.fn(async () => ({ finishesLater: false, endUnit: 6, reason: "test" }));
    await lookPastTheEnd(units, { startMs: units[0].startMs, endMs: units[6].endMs }, askLook, 90_000, () => "CUSTOM LOOK PROMPT");
    expect(askLook).toHaveBeenCalledWith("CUSTOM LOOK PROMPT");
  });
});

describe("fix Z: the hook sits within the first 35 seconds of the current clip", () => {
  // EVEN: unit i runs i*3000 to i*3000+2900, and the current clip is units 10 to 19 (30 to 59.9 s).
  it("refuses a first answer that starts more than 35 seconds after the current start", () => {
    const refused = boundaryRefusal(EVEN, { startUnit: 22, endUnit: 31 });
    expect(refused).toContain("Unit [22] starts 36.0 seconds after the current clip's start, unit [10].");
    expect(refused).toContain("start on unit [10], on a line up to unit [21], or earlier.");
    expect(boundaryRefusal(EVEN, { startUnit: 21, endUnit: 30 })).toBeNull();
    expect(boundaryRefusal(EVEN, { startUnit: 5, endUnit: 15 })).toBeNull();
  });

  it("lets the clip start later once an answer ran too long, and when the story check holds the end", async () => {
    const answers = [
      { startUnit: 0, endUnit: 31, reason: "too long" },
      { startUnit: 22, endUnit: 31, reason: "later" },
    ];
    const ask = vi.fn(async () => answers.shift()!);
    const chosen = await chooseBoundary(EVEN, ask);
    expect(chosen.attempts[0].refused).toContain("must not run past 90 seconds");
    expect(chosen.range).toMatchObject({ startMs: 66_000 });
    const held = await chooseBoundary(EVEN, async () => ({ startUnit: 22, endUnit: 30, reason: "held" }), undefined, {
      endUnit: 30,
      why: "The story lands at unit [30].",
    });
    expect(held.range).toMatchObject({ startMs: 66_000 });
  });
});

// Lab sermon 1q clip 2 (2026-10-26), 73:05–74:02: the clip opened on the label "Saving grace." and a 2.5 s pause.
const ONE_Q_C2: BoundaryUnit[] = [
  { idx: 1052, startMs: 4385040, endMs: 4385540, text: "Amen." },
  { idx: 1053, startMs: 4386560, endMs: 4387540, text: "Saving grace." },
  { idx: 1054, startMs: 4390060, endMs: 4393680, text: "For by grace are you saved through faith, not of yourself." },
  { idx: 1055, startMs: 4395380, endMs: 4396020, text: "It's a gift." },
  { idx: 1056, startMs: 4397100, endMs: 4401620, text: "It's a gift of God, not of works, lest any man should boast." },
  { idx: 1057, startMs: 4401880, endMs: 4403380, text: "You're trying to work your way to God." },
  { idx: 1058, startMs: 4403440, endMs: 4405100, text: "Some of you are just, that's you today." },
  { idx: 1059, startMs: 4405140, endMs: 4406440, text: "You're just trying to work." },
  { idx: 1060, startMs: 4406700, endMs: 4409920, text: "You're trying to, you know, claw your way to God." },
  { idx: 1061, startMs: 4410640, endMs: 4413700, text: "You're here today, say, \"Man, I'm at church today 'cause I wanna be at church.\"" },
  { idx: 1062, startMs: 4413740, endMs: 4414620, text: "Well, that's a great thing." },
  { idx: 1063, startMs: 4414680, endMs: 4415780, text: "We're glad you're here." },
  { idx: 1064, startMs: 4416600, endMs: 4419920, text: "Maybe, maybe I can turn over a new leaf and I'm just gonna start going to church." },
  { idx: 1065, startMs: 4419960, endMs: 4423560, text: "Well, that's wonderful, but going to church all day long's not gonna save you." },
  { idx: 1066, startMs: 4423620, endMs: 4425140, text: "You need the saving grace of God." },
  { idx: 1067, startMs: 4425340, endMs: 4426560, text: "Amen." },
  { idx: 1068, startMs: 4426600, endMs: 4429460, text: "It's a gift of God, not of works, lest any man should boast." },
  { idx: 1069, startMs: 4429640, endMs: 4430120, text: "Praise Him." },
  { idx: 1070, startMs: 4430160, endMs: 4431880, text: "It's the amazing grace of God." },
  { idx: 1071, startMs: 4432620, endMs: 4438120, text: "Man, I'm so grateful that God saved a wretch like me and a wretch like you." },
  { idx: 1072, startMs: 4438720, endMs: 4438800, text: "Amen." },
  { idx: 1073, startMs: 4438860, endMs: 4439880, text: "Saving grace." },
  { idx: 1074, startMs: 4441520, endMs: 4442420, text: "But what else is there?" },
];

describe("fix AA: a short label with a pause after it is not the opening line (lab sermon 1q clip 2)", () => {
  const range = { startMs: 4386560, endMs: 4438120 };
  const context = boundaryContext(ONE_Q_C2, range);
  const unit = (start: string) => context.units.findIndex((u) => u.text.startsWith(start));

  it("sees a label of three words or fewer followed by a pause of two seconds or more", () => {
    expect(labelStart(context.units, unit("Saving grace."))).toBe(true);
    // Three words, but the next line follows within 1.1 s.
    expect(labelStart(context.units, unit("It's a gift."))).toBe(false);
    expect(labelStart(context.units, unit("For by grace"))).toBe(false);
    // A short question with a pause is a hook, not a label.
    const question: BoundaryUnit[] = [
      { idx: 1, startMs: 0, endMs: 900, text: "Do you have it?" },
      { idx: 2, startMs: 3500, endMs: 6000, text: "Man, I gotta tell y'all, I am so glad today that I am saved." },
    ];
    expect(labelStart(question, 0)).toBe(false);
  });

  it("moves the start past the label", () => {
    const choice = { startUnit: unit("Saving grace."), endUnit: unit("Man, I'm so grateful") };
    expect(applyBoundaryChoice(context, choice)).toMatchObject({ startMs: 4390060, endMs: 4438120, adjustedStart: true });
    expect(applyBoundaryChoice(context, { startUnit: unit("For by grace"), endUnit: unit("Man, I'm so grateful") })).toMatchObject({
      startMs: 4390060,
      adjustedStart: false,
    });
    const short = boundaryRefusal(context, { startUnit: unit("Saving grace."), endUnit: unit("It's a gift of God") });
    expect(short).toContain("The start moved past a short label line.");
  });
});

// Lab sermon 3m clip 2 (2026-10-26), 31:23–32:24: a joke, the applause call, "You can be seated.", then the subject.
const THREE_M_C2: BoundaryUnit[] = [
  { idx: 445, startMs: 1883480, endMs: 1887080, text: "if I catch you, uh, this is a wireless mic." },
  { idx: 446, startMs: 1887180, endMs: 1889140, text: "I can walk right out there where you are, all right?" },
  { idx: 447, startMs: 1890540, endMs: 1896860, text: "But if I catch you, what we're gonna do after church is this: we're gonna go outside and find a grassy area, and we're gonna sumo wrestle." },
  { idx: 448, startMs: 1899820, endMs: 1903700, text: "First thing you'll see is my belly button, the second thing you'll see is Jesus, amen?" },
  { idx: 449, startMs: 1904660, endMs: 1907460, text: "Let's give, let's give a hand for these young people tonight, amen." },
  { idx: 450, startMs: 1908200, endMs: 1911300, text: "You can be seated." },
  { idx: 451, startMs: 1911420, endMs: 1912820, text: "Acts chapter 26." },
  { idx: 452, startMs: 1912900, endMs: 1920540, text: "I'm just gonna read, uh, a few verses, and then we're gonna look at, uh, this scripture tonight, and I pray the Holy Spirit will, will speak to you." },
  { idx: 453, startMs: 1920540, endMs: 1923000, text: "And I wanna preach on this subject tonight: almost." },
  { idx: 454, startMs: 1924360, endMs: 1924480, text: "Almost." },
  { idx: 455, startMs: 1924520, endMs: 1930000, text: "Why, why are some people almost saved, but not altogether saved?" },
  { idx: 456, startMs: 1930040, endMs: 1930300, text: "Yeah." },
  { idx: 457, startMs: 1930860, endMs: 1931200, text: "Amen." },
  { idx: 458, startMs: 1931980, endMs: 1938280, text: "Why are many of us tonight, that are born again, why are we almost sold out to Jesus, but we're not totally sold out to Jesus?" },
  { idx: 460, startMs: 1940880, endMs: 1944440, text: "Well, look with me, if you will, in Acts chapter, uh, 26." },
];

describe("fix AD: a clip never spans a section break, and the hook window counts from the break (lab sermon 3m clip 2)", () => {
  const range = { startMs: 1885432, endMs: 1930152 };
  const context = boundaryContext(THREE_M_C2, range);
  const unit = (start: string) => context.units.findIndex((u) => u.text.startsWith(start));

  it("knows an applause call and 'you can be seated' as section breaks", () => {
    expect(sectionBreak("Let's give, let's give a hand for these young people tonight, amen.")).toBe(true);
    expect(sectionBreak("You can be seated.")).toBe(true);
    expect(sectionBreak("Put your hands together for the choir.")).toBe(true);
    expect(sectionBreak("First thing you'll see is my belly button, the second thing you'll see is Jesus, amen?")).toBe(false);
    expect(sectionBreakInside(context.units, unit("But if I catch you"), unit("Why are many of us"))).toBe(unit("Let's give"));
    expect(sectionBreakInside(context.units, unit("Acts chapter 26."), unit("Why are many of us"))).toBeNull();
  });

  it("refuses a range that spans the break, and accepts one that ends on it", () => {
    const refused = boundaryRefusal(context, { startUnit: unit("But if I catch you"), endUnit: unit("Why are many of us") });
    expect(refused).toContain(`Unit [${unit("Let's give")}] closes one part of the service and opens another`);
    expect(refused).toContain(`start after unit [${unit("Let's give")}], or end before it.`);
    expect(applyBoundaryChoice(context, { startUnit: unit("But if I catch you"), endUnit: unit("Let's give") })).toMatchObject({ startMs: 1890540 });
  });

  it("counts the hook window from the line after the break, so the subject line is accepted 37 seconds in", async () => {
    // 37.1 s after the current clip's start, but 9.1 s after "Acts chapter 26.", the line after "You can be seated."
    expect(boundaryRefusal(context, { startUnit: unit("And I wanna preach"), endUnit: unit("Why are many of us") })).toBeNull();
    const chosen = await chooseBoundary(context, async () => ({ startUnit: unit("And I wanna preach"), endUnit: unit("Why are many of us"), reason: "the subject" }));
    expect(chosen.attempts[0].refused).toBeNull();
    expect(chosen.range).toMatchObject({ startMs: 1920540, endMs: 1938280 });
  });

  it("still refuses a start more than 35 seconds after the break", () => {
    const late = THREE_M_C2.map((u) => ({ ...u }));
    late.push({ idx: 461, startMs: 1947000, endMs: 1960000, text: "Now here is the thing I want you to see tonight about being almost persuaded." });
    late.push({ idx: 462, startMs: 1960100, endMs: 1966000, text: "Almost is not altogether, and almost will send you to hell." });
    const ctx = boundaryContext(late, range);
    const at = (start: string) => ctx.units.findIndex((u) => u.text.startsWith(start));
    const refused = boundaryRefusal(ctx, { startUnit: at("Now here is the thing"), endUnit: at("Almost is not altogether") });
    expect(refused).toContain(`starts 35.6 seconds after the line after the section break at unit [${at("You can be seated.")}], unit [${at("Acts chapter 26.")}]`);
  });
});

// Lab sermon 4k clip 1 (2026-10-26), 48:01–49:00: the model ended one line past the punch line, on a next-point opener.
const FOUR_K_C1: BoundaryUnit[] = [
  { idx: 530, startMs: 2881140, endMs: 2890820, text: "That Mount of Transfiguration experience tells me that the only gospel there is is the gospel that is through Jesus Christ." },
  { idx: 531, startMs: 2891320, endMs: 2891380, text: "Amen." },
  { idx: 532, startMs: 2891440, endMs: 2895740, text: "There is no other name under heaven given among men whereby we must be saved." },
  { idx: 533, startMs: 2896080, endMs: 2898180, text: "It is not in the name of Moses." },
  { idx: 534, startMs: 2898400, endMs: 2900260, text: "It is not in the name of Elijah." },
  { idx: 535, startMs: 2900480, endMs: 2902340, text: "It is not in the name of Confucius." },
  { idx: 536, startMs: 2902580, endMs: 2904320, text: "It is not in the name of Muhammad." },
  { idx: 537, startMs: 2904500, endMs: 2906020, text: "It is not in the name of Buddha." },
  { idx: 538, startMs: 2906300, endMs: 2909140, text: "It's only in the name of Jesus Christ." },
  { idx: 539, startMs: 2909340, endMs: 2917280, text: "There is one mediator between a sinner and a holy God, and it is the God man, the Lord Jesus Christ." },
  { idx: 540, startMs: 2920520, endMs: 2920740, text: "Yes." },
  { idx: 541, startMs: 2920740, endMs: 2929060, text: "But it also tells me, now listen, it also tells me that salvation is a powerful experience." },
  { idx: 542, startMs: 2929820, endMs: 2929880, text: "Amen." },
  { idx: 543, startMs: 2929940, endMs: 2932000, text: "Because we are changed." },
  { idx: 544, startMs: 2932260, endMs: 2933600, text: "Yes, sir." },
  { idx: 545, startMs: 2933660, endMs: 2940540, text: "Now listen, we're changed not from the outside in, but from the inside out." },
];

describe("fix AE: a line that opens the next point is not the ending (lab sermon 4k clip 1)", () => {
  const range = { startMs: 2880916, endMs: 2920896 };
  const context = boundaryContext(FOUR_K_C1, range);
  const unit = (start: string) => context.units.findIndex((u) => u.text.startsWith(start));

  it("knows the openers", () => {
    expect(opensNextPoint("But it also tells me, now listen, it also tells me that salvation is a powerful experience.")).toBe(true);
    expect(opensNextPoint("Not only that, He rose again on the third day.")).toBe(true);
    expect(opensNextPoint("There's another thing I want you to see here.")).toBe(true);
    expect(opensNextPoint("And here's something else we learn from Peter.")).toBe(true);
    expect(opensNextPoint("Because we are changed.")).toBe(false);
    expect(opensNextPoint("It is not in the name of Moses.")).toBe(false);
    expect(opensNextPoint("You also need to know this tonight.")).toBe(false);
  });

  it("moves the end back past the opener and the crowd word before it", () => {
    expect(endBeforeNextPoint(context.units, unit("That Mount"), unit("But it also tells me"))).toBe(unit("There is one mediator"));
    expect(applyBoundaryChoice(context, { startUnit: unit("That Mount"), endUnit: unit("But it also tells me") })).toMatchObject({
      endMs: 2917280,
      adjustedEnd: true,
    });
    expect(applyBoundaryChoice(context, { startUnit: unit("That Mount"), endUnit: unit("There is one mediator") })).toMatchObject({
      endMs: 2917280,
      adjustedEnd: false,
    });
  });

  it("never lets the end look move onto an opener", async () => {
    // The opener ends within 6 seconds of the cut here, so the look shows it.
    const units = FOUR_K_C1.map((u) => (u.idx === 541 ? { ...u, endMs: 2922700 } : u));
    const ctx = boundaryContext(units, range);
    const clip = { startMs: 2881140, endMs: 2917280 };
    const lines = endLookLines(ctx.units, clip)!;
    const opener = lines.lines.findIndex((u) => u.text.startsWith("But it also tells me"));
    expect(opener).toBeGreaterThan(lines.end);
    const looked = await lookPastTheEnd(ctx.units, clip, async () => ({ finishesLater: true, endUnit: opener, reason: "it goes on" }));
    expect(looked.range).toEqual(clip);
    expect(looked.look.refused).toBe(`Unit [${opener}] opens the next point.`);
  });
});
