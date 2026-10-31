import { describe, expect, it } from "vitest";
import { computeIoU } from "@/lib/analysis/chunking";
import { MAX_STAGE_B_CANDIDATES, StageAResultSchema, stageAPrompt, stageBPrompt, thinStageASurvivors } from "@/lib/analysis/pipeline";
import type { AnalysisCandidate } from "@/lib/analysis/types";

const MINUTE = 60_000;

/** Evenly spaced 55-second windows from `fromMin` to `toMin`, the shape buildCandidateWindows makes. */
function windows(fromMin: number, toMin: number, count: number): AnalysisCandidate[] {
  const step = ((toMin - fromMin) * MINUTE) / count;
  return Array.from({ length: count }, (_, i) => {
    const startMs = Math.round(fromMin * MINUTE + i * step);
    return { startMs, endMs: startMs + 55_000, text: `Window at ${startMs} ms.` };
  });
}

function allSurvive(candidates: AnalysisCandidate[]) {
  return candidates.map((_, index) => ({ index, momentType: "complete_thought" as const }));
}

function minutesOf(candidates: AnalysisCandidate[], kept: number[]) {
  return kept.map((index) => candidates[index].startMs / MINUTE);
}

describe("thinStageASurvivors spreads Stage B across the whole service", () => {
  it("draws from every part of an 85-minute service, not the first 25 in time", () => {
    // Lab sermon 1 (2026-10-17): 500 windows over 85 minutes, and every one of the 6 clips came
    // from the first 12 minutes because Stage B received the first 25 survivors in time order.
    const candidates = windows(0, 85, 500);
    const kept = thinStageASurvivors(candidates, allSurvive(candidates));
    const minutes = minutesOf(candidates, kept);

    expect(kept).toHaveLength(MAX_STAGE_B_CANDIDATES);
    expect(Math.min(...minutes)).toBeLessThan(10);
    expect(Math.max(...minutes)).toBeGreaterThan(75);
    for (let fifth = 0; fifth < 5; fifth += 1) {
      const from = fifth * 17;
      const inFifth = minutes.filter((m) => m >= from && m < from + 17).length;
      expect(inFifth, `minutes ${from}-${from + 17}`).toBeGreaterThanOrEqual(4);
    }
  });

  it("sends mostly sermon candidates when the opening and the sermon both survive Stage A", () => {
    // Welcome, songs and baptisms fill minutes 0-12; the sermon runs 33-85. Stage A kept both.
    const opening = windows(0, 12, 100);
    const sermon = windows(33, 85, 300);
    const candidates = [...opening, ...sermon];
    const kept = thinStageASurvivors(candidates, allSurvive(candidates));
    const fromSermon = minutesOf(candidates, kept).filter((m) => m >= 33).length;

    expect(kept).toHaveLength(MAX_STAGE_B_CANDIDATES);
    expect(fromSermon).toBeGreaterThanOrEqual(15);
  });

  it("never sends two heavily overlapping windows", () => {
    const candidates = windows(0, 85, 500);
    const kept = thinStageASurvivors(candidates, allSurvive(candidates));
    for (const a of kept) {
      for (const b of kept) {
        if (a !== b) expect(computeIoU(candidates[a], candidates[b])).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it("returns the chosen windows in time order", () => {
    const candidates = windows(0, 85, 500);
    const classifications = allSurvive(candidates).reverse();
    const kept = thinStageASurvivors(candidates, classifications);
    const starts = kept.map((index) => candidates[index].startMs);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("keeps every non-overlapping survivor when there are no more than 25, and drops rejects", () => {
    const candidates = windows(0, 20, 10); // 2 minutes apart: no overlap
    const classifications = [
      ...allSurvive(candidates).map((c) => (c.index % 3 === 0 ? { ...c, momentType: "reject" as const } : c)),
      { index: 1, momentType: "hook" as const }, // a duplicate entry from the model
      { index: 99, momentType: "hook" as const }, // an index that does not exist
      { index: -1, momentType: "hook" as const },
    ];
    expect(thinStageASurvivors(candidates, classifications)).toEqual([1, 2, 4, 5, 7, 8]);
  });

  it("returns nothing when Stage A rejects everything", () => {
    const candidates = windows(0, 10, 5);
    const classifications = candidates.map((_, index) => ({ index, momentType: "reject" as const }));
    expect(thinStageASurvivors(candidates, classifications)).toEqual([]);
  });
});

describe("stageAPrompt rejects church-service content that is not preaching", () => {
  const prompt = stageAPrompt([
    { startMs: 0, endMs: 55_000, text: "You called my name and I ran out of that grave." },
    { startMs: 60_000, endMs: 115_000, text: "Notice with me from the Word of God." },
  ]);

  it.each([
    ["worship and song lyrics", /worship/i, /song|sung|singing/i],
    ["baptisms", /baptism/i, /baptism/i],
    ["announcements", /announcement/i, /announcement/i],
    ["prayer", /prayer|praying/i, /prayer|praying/i],
    ["altar calls and invitations", /altar call/i, /invitation/i],
  ])("names %s as reject", (_label, first, second) => {
    const rejectRule = prompt.slice(0, prompt.indexOf("[0]"));
    expect(rejectRule).toMatch(first);
    expect(rejectRule).toMatch(second);
  });

  it("keeps a preacher who quotes a song or reads Scripture inside the sermon", () => {
    expect(prompt).toMatch(/still preaching/i);
  });

  it("still lists every excerpt with its number", () => {
    expect(prompt).toContain("[0] You called my name and I ran out of that grave.");
    expect(prompt).toContain("[1] Notice with me from the Word of God.");
  });
});

describe("StageAResultSchema", () => {
  // Lab sermon 3b, 2026-10-18: ANALYZE failed three times with "Failed to parse structured
  // output". The SDK sends the moment types as a description, not an enforced list, so the
  // model can write any word, and one unknown word failed the whole sermon.
  it("reads an unknown moment type as reject instead of failing the sermon", () => {
    const result = StageAResultSchema.parse({
      classifications: [
        { index: 0, momentType: "worship" },
        { index: 1, momentType: "complete_thought" },
      ],
    });
    expect(result.classifications.map((c) => c.momentType)).toEqual(["reject", "complete_thought"]);
  });

  it("reads a known moment type written in another case or with spaces", () => {
    const result = StageAResultSchema.parse({
      classifications: [
        { index: 0, momentType: " Hook " },
        { index: 1, momentType: "Call to action" },
      ],
    });
    expect(result.classifications.map((c) => c.momentType)).toEqual(["hook", "call_to_action"]);
  });
});

// Fix N (lab sermons 4e and 1k, 2026-10-20): Stage B received 25 windows but returned only 7 to 11,
// the ones it liked, so the lab steps had no reserves and sermon 4e ended with 3 clips. On sermon
// 4's transcript the old prompt scored 10 of 25 twice; asking for one entry per window scored 25.
describe("stageBPrompt asks for one scored entry per window it sends (fix N)", () => {
  const candidates = windows(0, 85, 40);
  const context = { fullText: "full transcript", genre: "sermon" };

  it("names the exact number of windows sent, and that weak ones are scored low, not left out", () => {
    const kept = [2, 5, 9, 14, 30];
    const prompt = stageBPrompt(candidates, kept, context);
    expect(prompt).toContain("Score every numbered excerpt below: return exactly 5 entries in scoredClips, one per number");
    expect(prompt).toContain("even for weak excerpts. Low scores are how weak excerpts are ranked out.");
    expect(stageBPrompt(candidates, thinStageASurvivors(candidates, allSurvive(candidates)), context)).toContain(
      `return exactly ${Math.min(MAX_STAGE_B_CANDIDATES, 40)} entries`,
    );
  });

  it("still lists each window sent, by its number, after the instructions", () => {
    const prompt = stageBPrompt(candidates, [2, 5], context);
    expect(prompt.indexOf("return exactly 2 entries")).toBeLessThan(prompt.indexOf("[2] Window at"));
    expect(prompt).toContain("[5] Window at");
    expect(prompt).not.toContain("[3] Window at");
  });
});
