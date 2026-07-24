import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnalysisResponseTruncatedError,
  ClaudeAnalysisProvider,
  classifyModel,
  scoringModel,
} from "@/lib/analysis/claude-provider";
import { AnalysisProviderUnavailableError } from "@/lib/analysis/types";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    // Both stages stream (messages.stream → finalMessage): Stage A first, then Stage B.
    messages = { stream: streamMock };
  },
}));

const USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** Fake `messages.stream(...)` return: the provider awaits `.finalMessage()`. */
function streamResult(text: string, stopReason = "end_turn") {
  return {
    finalMessage: vi.fn().mockResolvedValue({
      content: [{ type: "text", text }],
      usage: USAGE,
      stop_reason: stopReason,
    }),
  };
}

function stageAStreamResult(opts: {
  classifications?: Array<{ index: number; momentType: string }>;
  stopReason?: string;
  rawText?: string;
}) {
  const text =
    opts.rawText ??
    (opts.classifications
      ? JSON.stringify({ classifications: opts.classifications })
      : "not-json{");
  return streamResult(text, opts.stopReason);
}

function stageBClip(index: number) {
  const subscore = { score: 80, note: "solid" };
  return {
    index,
    title: `Clip ${index}`,
    hookText: "A strong hook",
    summary: "A clear standalone moment.",
    excerpt: "quoted text",
    subscores: {
      hookStrength: subscore,
      clarity: subscore,
      emotionalImpact: subscore,
      completeness: subscore,
      shareability: subscore,
      topicRelevance: subscore,
    },
  };
}

function stageBStreamResult(opts: {
  clips?: Array<ReturnType<typeof stageBClip>>;
  stopReason?: string;
  rawText?: string;
}) {
  const text =
    opts.rawText ?? (opts.clips ? JSON.stringify({ scoredClips: opts.clips }) : "not-json{");
  return streamResult(text, opts.stopReason);
}

function candidates(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    startMs: i * 30_000,
    endMs: i * 30_000 + 25_000,
    text: `Candidate ${i} says something meaningful about hope and grace in this moment.`,
  }));
}

const CONTEXT = { fullText: "full transcript", genre: "podcast" };

beforeEach(() => {
  streamMock.mockReset();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANALYSIS_MODEL_CLASSIFY;
  delete process.env.ANALYSIS_MODEL_SCORING;
});

describe("model configuration", () => {
  it("defaults stage models and honors env overrides", () => {
    expect(classifyModel()).toBe("claude-haiku-4-5");
    expect(scoringModel()).toBe("claude-sonnet-5");
    process.env.ANALYSIS_MODEL_CLASSIFY = "claude-haiku-9";
    process.env.ANALYSIS_MODEL_SCORING = "claude-sonnet-9";
    expect(classifyModel()).toBe("claude-haiku-9");
    expect(scoringModel()).toBe("claude-sonnet-9");
    expect(new ClaudeAnalysisProvider().name).toBe("claude-sonnet-9");
  });

  it("passes the configured models to the API calls", async () => {
    process.env.ANALYSIS_MODEL_CLASSIFY = "claude-haiku-9";
    process.env.ANALYSIS_MODEL_SCORING = "claude-sonnet-9";
    streamMock
      .mockReturnValueOnce(
        stageAStreamResult({ classifications: [{ index: 0, momentType: "hook" }] }),
      )
      .mockReturnValueOnce(stageBStreamResult({ clips: [stageBClip(0)] }));

    await new ClaudeAnalysisProvider().scoreCandidates(candidates(1), CONTEXT);

    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(streamMock.mock.calls[0][0].model).toBe("claude-haiku-9");
    expect(streamMock.mock.calls[1][0].model).toBe("claude-sonnet-9");
  });
});

describe("scoreCandidates", () => {
  it("throws AnalysisProviderUnavailableError without an API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      new ClaudeAnalysisProvider().scoreCandidates(candidates(1), CONTEXT),
    ).rejects.toBeInstanceOf(AnalysisProviderUnavailableError);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("scores kept candidates end to end and records usage for both stages", async () => {
    streamMock
      .mockReturnValueOnce(
        stageAStreamResult({
          classifications: [
            { index: 0, momentType: "hook" },
            { index: 1, momentType: "complete_thought" },
          ],
        }),
      )
      .mockReturnValueOnce(stageBStreamResult({ clips: [stageBClip(0), stageBClip(1)] }));

    const provider = new ClaudeAnalysisProvider();
    const scored = await provider.scoreCandidates(candidates(2), CONTEXT);

    expect(scored).toHaveLength(2);
    expect(scored[0]).toMatchObject({
      title: "Clip 0",
      modelVersion: "claude-sonnet-5",
    });
    expect(scored[0].total).toBeGreaterThan(0);
    expect(scored[0].subscores.hook_strength.letter).toBeDefined();

    expect(provider.lastUsage).not.toBeNull();
    expect(provider.lastUsage?.calls.map((c) => c.model)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-5",
    ]);
    expect(provider.lastUsage?.totalInputTokens).toBe(2000);
  });

  it("drops candidates Stage A rejects and never sends them to Stage B", async () => {
    streamMock
      .mockReturnValueOnce(
        stageAStreamResult({
          classifications: [
            { index: 0, momentType: "reject" },
            { index: 1, momentType: "story" },
          ],
        }),
      )
      .mockReturnValueOnce(stageBStreamResult({ clips: [stageBClip(1)] }));

    const scored = await new ClaudeAnalysisProvider().scoreCandidates(candidates(2), CONTEXT);

    expect(scored).toHaveLength(1);
    const stageBPrompt = streamMock.mock.calls[1][0].messages[0].content as string;
    expect(stageBPrompt).toContain("[1]");
    expect(stageBPrompt).not.toContain("[0]");
  });

  it("returns empty without calling Stage B when everything is rejected", async () => {
    streamMock.mockReturnValueOnce(
      stageAStreamResult({ classifications: [{ index: 0, momentType: "reject" }] }),
    );

    const provider = new ClaudeAnalysisProvider();
    const scored = await provider.scoreCandidates(candidates(1), CONTEXT);

    expect(scored).toEqual([]);
    expect(streamMock).toHaveBeenCalledTimes(1);
    // Stage A spend is still recorded even when nothing survives.
    expect(provider.lastUsage?.calls).toHaveLength(1);
  });

  it("caps Stage B at 25 candidates", async () => {
    const many = candidates(30);
    streamMock
      .mockReturnValueOnce(
        stageAStreamResult({
          classifications: many.map((_, index) => ({ index, momentType: "hook" })),
        }),
      )
      .mockReturnValueOnce(stageBStreamResult({ clips: [stageBClip(0)] }));

    await new ClaudeAnalysisProvider().scoreCandidates(many, CONTEXT);

    const stageBPrompt = streamMock.mock.calls[1][0].messages[0].content as string;
    expect(stageBPrompt).toContain("[24]");
    expect(stageBPrompt).not.toContain("[25]");
  });

  it("throws when Stage A output is truncated at the token cap", async () => {
    streamMock.mockReturnValueOnce(
      stageAStreamResult({
        classifications: [{ index: 0, momentType: "hook" }],
        stopReason: "max_tokens",
      }),
    );
    await expect(
      new ClaudeAnalysisProvider().scoreCandidates(candidates(1), CONTEXT),
    ).rejects.toBeInstanceOf(AnalysisResponseTruncatedError);
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("throws when Stage A output is unparseable rather than silently returning zero clips", async () => {
    streamMock.mockReturnValueOnce(
      stageAStreamResult({ rawText: '{"classifications": [{"index":' }),
    );
    await expect(
      new ClaudeAnalysisProvider().scoreCandidates(candidates(1), CONTEXT),
    ).rejects.toBeInstanceOf(AnalysisResponseTruncatedError);
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("throws when Stage B output is truncated at the token cap", async () => {
    streamMock
      .mockReturnValueOnce(
        stageAStreamResult({ classifications: [{ index: 0, momentType: "hook" }] }),
      )
      .mockReturnValueOnce(
        stageBStreamResult({ clips: [stageBClip(0)], stopReason: "max_tokens" }),
      );
    await expect(
      new ClaudeAnalysisProvider().scoreCandidates(candidates(1), CONTEXT),
    ).rejects.toBeInstanceOf(AnalysisResponseTruncatedError);
  });

  it("throws when Stage B output is unparseable rather than silently returning zero clips", async () => {
    streamMock
      .mockReturnValueOnce(
        stageAStreamResult({ classifications: [{ index: 0, momentType: "hook" }] }),
      )
      .mockReturnValueOnce(stageBStreamResult({ rawText: '{"scoredClips": [{"index":' }));
    await expect(
      new ClaudeAnalysisProvider().scoreCandidates(candidates(1), CONTEXT),
    ).rejects.toBeInstanceOf(AnalysisResponseTruncatedError);
  });

  it("ignores scored clips whose index is out of range", async () => {
    streamMock
      .mockReturnValueOnce(
        stageAStreamResult({ classifications: [{ index: 0, momentType: "hook" }] }),
      )
      .mockReturnValueOnce(stageBStreamResult({ clips: [stageBClip(0), stageBClip(7)] }));

    const scored = await new ClaudeAnalysisProvider().scoreCandidates(candidates(1), CONTEXT);
    expect(scored).toHaveLength(1);
  });

  it("propagates API errors so the job retry machinery handles them", async () => {
    streamMock.mockReturnValueOnce({
      finalMessage: vi.fn().mockRejectedValue(new Error("529 overloaded")),
    });
    await expect(
      new ClaudeAnalysisProvider().scoreCandidates(candidates(1), CONTEXT),
    ).rejects.toThrow("529 overloaded");
  });

  it("applies church subscores and scripture detection for sermons", async () => {
    streamMock
      .mockReturnValueOnce(
        stageAStreamResult({ classifications: [{ index: 0, momentType: "teachable" }] }),
      )
      .mockReturnValueOnce(stageBStreamResult({ clips: [stageBClip(0)] }));

    const sermonCandidates = [
      {
        startMs: 0,
        endMs: 25_000,
        text: "Turn with me to John 3:16, where the gospel shows God's grace for us.",
      },
    ];
    const scored = await new ClaudeAnalysisProvider().scoreCandidates(sermonCandidates, {
      fullText: "sermon transcript",
      genre: "sermon",
    });

    expect(scored[0].subscores.biblical_usefulness).toBeDefined();
    expect(scored[0].subscores.scripture_relevance).toBeDefined();
    expect(scored[0].scriptureReferences?.[0]?.normalized).toContain("John 3:16");
  });
});
