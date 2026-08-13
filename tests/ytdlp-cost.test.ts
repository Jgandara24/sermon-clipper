import { describe, expect, it } from "vitest";
import { buildYtDlpCostFacts, type YtDlpTransferTelemetry } from "@/lib/media/ytdlp";

function transfer(overrides: Partial<YtDlpTransferTelemetry> = {}): YtDlpTransferTelemetry {
  return {
    bytes: 1_000_000_000,
    sourceDurationS: 1_000,
    bitrateBitsPerSecond: 8_000_000,
    proxyUsed: false,
    proxyHost: null,
    wallTimeMs: 20_000,
    ...overrides,
  };
}

describe("buildYtDlpCostFacts", () => {
  it("records direct acquisition as known zero cost", () => {
    const [acquisition] = buildYtDlpCostFacts(transfer(), {
      proxyPricePerGbUsd: null,
      railwayEgressPricePerGbUsd: 0.05,
      attempt: 1,
      outcome: "succeeded",
    });

    expect(acquisition).toMatchObject({
      stage: "source_acquisition",
      quantity: 1,
      unit: "gigabyte",
      unitCostUsd: 0,
      provider: "yt_dlp_direct",
      attempt: 1,
      outcome: "succeeded",
    });
  });

  it("prices proxy acquisition without exposing credentials", () => {
    const [acquisition] = buildYtDlpCostFacts(
      transfer({ proxyUsed: true, proxyHost: "proxy.example" }),
      {
        proxyPricePerGbUsd: 2.5,
        railwayEgressPricePerGbUsd: null,
        attempt: 2,
        outcome: "failed",
      },
    );

    expect(acquisition).toMatchObject({
      unitCostUsd: 2.5,
      provider: "residential_proxy",
      attempt: 2,
      outcome: "failed",
      details: { proxyUsed: true, proxyHost: "proxy.example" },
    });
    expect(JSON.stringify(acquisition)).not.toContain("user:pass");
    expect(JSON.stringify(acquisition)).not.toContain("http://");
  });

  it("leaves missing proxy and Railway prices explicitly unpriced", () => {
    const [acquisition, egress] = buildYtDlpCostFacts(
      transfer({ proxyUsed: true, proxyHost: "proxy.example" }),
      {
        proxyPricePerGbUsd: null,
        railwayEgressPricePerGbUsd: null,
        attempt: 1,
        outcome: "succeeded",
      },
    );

    expect(acquisition.unitCostUsd).toBeNull();
    expect(egress.unitCostUsd).toBeNull();
  });
});
