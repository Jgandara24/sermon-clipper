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
  endsOnQuotationStart,
  boundaryContext,
  boundaryPrompt,
  looksLikeScriptureReadingStart,
  lookPastTheEnd,
  prayerInClip,
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

  it("accepts a clip of up to 90 seconds and refuses a longer one (Jake, 2026-10-20)", () => {
    // "If the clip's main point goes past 60 seconds and closer to something like 75 seconds, then
    // let it be. Try to refrain from going past 90 seconds."
    const units = Array.from({ length: 40 }, (_, i) => ({ idx: i, startMs: i * 3_000, endMs: i * 3_000 + 2_900, text: "Point." }));
    const context = boundaryContext(units, { startMs: 30_000, endMs: 60_000 }, 90_000);
    expect(applyBoundaryChoice(context, { startUnit: 0, endUnit: 24 })).toMatchObject({ startMs: 0, endMs: 74_900 });
    expect(applyBoundaryChoice(context, { startUnit: 0, endUnit: 29 })).toEqual({ startMs: 0, endMs: 89_900, adjustedForScripture: false, adjustedEnd: false });
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
