import { describe, expect, it } from "vitest";
import { HeuristicAnalysisProvider } from "@/lib/analysis/heuristic-provider";

const CONTEXT = { fullText: "peace hope faith trust prayer sermon message", genre: "sermon" };

describe("HeuristicAnalysisProvider", () => {
  it("is always available", async () => {
    const provider = new HeuristicAnalysisProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it("scores sermon candidates with church-specific subscores", async () => {
    const provider = new HeuristicAnalysisProvider();
    const candidates = [
      {
        startMs: 0,
        endMs: 45_000,
        text: "John 14 says peace is not the absence of trouble. It is the presence of a steady God.",
      },
    ];

    const results = await provider.scoreCandidates(candidates, CONTEXT);
    expect(results).toHaveLength(1);

    const [result] = results;
    expect(result.modelVersion).toBe("heuristic-v1");
    expect(Object.keys(result.subscores).sort()).toEqual(
      [
        "clarity",
        "completeness",
        "biblical_usefulness",
        "emotional_impact",
        "pastoral_tone",
        "platform_fit",
        "shareability",
        "speaker_energy",
        "scripture_relevance",
        "theological_clarity",
      ].sort(),
    );
    expect(result.scriptureReferences?.map((ref) => ref.normalized)).toEqual(["John 14"]);
    expect(result.total).toBeGreaterThan(0);
    expect(result.title.length).toBeGreaterThan(0);
  });

  it("keeps the generic rubric for non-sermon genres", async () => {
    const provider = new HeuristicAnalysisProvider();
    const [result] = await provider.scoreCandidates(
      [
        {
          startMs: 0,
          endMs: 45_000,
          text: "Peace is not the absence of trouble. It is the presence of a steady God.",
        },
      ],
      { fullText: CONTEXT.fullText, genre: "talk" },
    );

    expect(Object.keys(result.subscores).sort()).toEqual(
      [
        "clarity",
        "completeness",
        "emotional_impact",
        "hook_strength",
        "platform_fit",
        "shareability",
        "speaker_energy",
        "topic_relevance",
      ].sort(),
    );
  });

  it("scores a clip with emotional language higher on shareability than a flat one", async () => {
    const provider = new HeuristicAnalysisProvider();
    const [emotional, flat] = await provider.scoreCandidates(
      [
        {
          startMs: 0,
          endMs: 30_000,
          text: "I was afraid and broken, but hope and grace carried me through the pain.",
        },
        {
          startMs: 30_000,
          endMs: 60_000,
          text: "The building was constructed in nineteen eighty four using standard materials.",
        },
      ],
      CONTEXT,
    );

    expect(emotional.subscores.shareability.score).toBeGreaterThan(flat.subscores.shareability.score);
  });

  it("never claims to be an AI model in modelVersion", async () => {
    const provider = new HeuristicAnalysisProvider();
    const [result] = await provider.scoreCandidates(
      [{ startMs: 0, endMs: 20_000, text: "A short test clip that resolves cleanly." }],
      CONTEXT,
    );
    expect(result.modelVersion).not.toMatch(/claude|gpt|gemini/i);
  });
});
