import { describe, expect, it } from "vitest";
import { parseNativeTime, runMeasuredProcess } from "@/lib/evaluation/local-process-measurement";

describe("native child resource measurements", () => {
  it("uses macOS bytes and Linux KiB without reading FFmpeg's maxrss label", () => {
    const mac = parseNativeTime("darwin_time", " 0.23 real 0.10 user 0.03 sys\n 52428800 maximum resident set size\nbench: maxrss=999999kB\n");
    const linux = parseNativeTime("gnu_time", "bench: maxrss=999999kB\nCODEX_NATIVE_TIME 0.10 0.03 51200\n");
    for (const result of [mac, linux]) expect(result).toMatchObject({
      status: "measured", userCpuMs: 100, systemCpuMs: 30, peakRssBytes: 52428800,
    });
  });

  it.each([
    ["darwin_time", "0.1 user 0.2 sys\n"],
    ["gnu_time", "CODEX_NATIVE_TIME 0.1 0.2 N/A\n"],
    ["gnu_time", "CODEX_NATIVE_TIME -1 0.2 20\n"],
    ["gnu_time", "CODEX_NATIVE_TIME 0.1 0.2 999999999999999999999\n"],
    ["gnu_time", "CODEX_NATIVE_TIME 0.1 0.2 100\nCODEX_NATIVE_TIME 0.1 0.2 100\n"],
  ] as const)("marks missing or ambiguous %s metrics unavailable", (kind, text) => {
    expect(parseNativeTime(kind, text)).toMatchObject({ status: "unavailable" });
  });

  it("retains a measured sub-resolution zero CPU time but does not turn absent memory into zero", () => {
    expect(parseNativeTime("gnu_time", "CODEX_NATIVE_TIME 0.00 0.00 32\n"))
      .toMatchObject({ status: "measured", userCpuMs: 0, systemCpuMs: 0, peakRssBytes: 32768 });
    expect(parseNativeTime("gnu_time", "CODEX_NATIVE_TIME 0.00 0.00 0\n"))
      .toMatchObject({ status: "unavailable" });
  });

  it("keeps command failure and unavailable resource measurements explicit", async () => {
    const result = await runMeasuredProcess(process.execPath, ["-e", "process.exit(7)"], {
      backend: { kind: "unavailable", reason: "native_timer_unavailable" }, timeoutMs: 5000,
    });
    expect(result).toMatchObject({ outcome: "failed", exitCode: 7,
      resources: { status: "unavailable", reason: "native_timer_unavailable" } });
    expect(result.wallTimeMs).toBeGreaterThan(0);
  });

  it("does not give a measured child database or provider credentials", async () => {
    const result = await runMeasuredProcess(process.execPath, ["-e",
      "process.exit(Object.keys(process.env).some(k=>/DATABASE|SECRET|TOKEN|API_KEY/.test(k))?9:0)"], {
      backend: { kind: "unavailable", reason: "native_timer_unavailable" }, timeoutMs: 5000,
    });
    expect(result).toMatchObject({ outcome: "succeeded", exitCode: 0 });
  });
});
