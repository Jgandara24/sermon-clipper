import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAnalysisProvider } from "@/lib/analysis";
import { AnalysisProviderUnavailableError } from "@/lib/analysis/types";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANALYSIS_ALLOW_HEURISTIC;
});

function setNodeEnv(value: "test" | "development" | "production") {
  process.env = { ...process.env, NODE_ENV: value };
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("getAnalysisProvider", () => {
  it("selects labeled heuristic analysis in tests without a key", async () => {
    setNodeEnv("test");

    const selection = await getAnalysisProvider();

    expect(selection.providerKind).toBe("heuristic");
    expect(selection.selectionReason).toBe("test_no_api_key");
    expect(selection.emergencyOverride).toBe(false);
    expect(selection.provider.name).toBe("heuristic");
  });

  it("selects labeled heuristic analysis in development without a key", async () => {
    setNodeEnv("development");

    const selection = await getAnalysisProvider();

    expect(selection.providerKind).toBe("heuristic");
    expect(selection.selectionReason).toBe("development_no_api_key");
    expect(selection.emergencyOverride).toBe(false);
  });

  it("fails closed in production without a key", async () => {
    setNodeEnv("production");

    await expect(getAnalysisProvider()).rejects.toBeInstanceOf(AnalysisProviderUnavailableError);
  });

  it("allows the exact production emergency override with labeled provenance", async () => {
    setNodeEnv("production");
    process.env.ANALYSIS_ALLOW_HEURISTIC = "true";

    const selection = await getAnalysisProvider();

    expect(selection.providerKind).toBe("heuristic");
    expect(selection.selectionReason).toBe("production_emergency_override");
    expect(selection.emergencyOverride).toBe(true);
  });

  it("rejects a non-exact emergency override value", async () => {
    setNodeEnv("production");
    process.env.ANALYSIS_ALLOW_HEURISTIC = "TRUE";

    await expect(getAnalysisProvider()).rejects.toBeInstanceOf(AnalysisProviderUnavailableError);
  });

  it("selects Claude when a key is configured", async () => {
    setNodeEnv("production");
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const selection = await getAnalysisProvider();

    expect(selection.providerKind).toBe("claude");
    expect(selection.selectionReason).toBe("claude_available");
    expect(selection.emergencyOverride).toBe(false);
    expect(selection.provider.name).toBe("claude-sonnet-5");
  });
});
