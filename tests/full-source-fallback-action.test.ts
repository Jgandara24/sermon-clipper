import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ requirePlatformOperator: vi.fn() }));
vi.mock("@/lib/exports/full-source-fallback-request", () => ({ requestFullSourceFallback: vi.fn() }));

import { submitFullSourceFallbackAction } from "@/app/actions/operator-full-source-export";
import { requirePlatformOperator } from "@/lib/auth";
import { FULL_SOURCE_FALLBACK_IDLE } from "@/lib/exports/full-source-fallback-input";
import { requestFullSourceFallback } from "@/lib/exports/full-source-fallback-request";

const CLIP = "11111111-1111-4111-8111-111111111111";
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  (requirePlatformOperator as Mock).mockResolvedValue({ id: "operator-1" });
  (requestFullSourceFallback as Mock).mockResolvedValue({ ok: true, created: true, exportJobId: "e",
    fullSourceFallbackId: "f", editorialExceptionId: "x" });
});

describe("submitFullSourceFallbackAction", () => {
  it("proves operator authority before reading the form", async () => {
    (requirePlatformOperator as Mock).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(submitFullSourceFallbackAction(FULL_SOURCE_FALLBACK_IDLE, form({ clipId: CLIP, reason: "r", confirmed: "on" })))
      .rejects.toThrow("NEXT_REDIRECT");
    expect(requestFullSourceFallback).not.toHaveBeenCalled();
  });

  it("requires the confirmation and a reason", async () => {
    expect(await submitFullSourceFallbackAction(FULL_SOURCE_FALLBACK_IDLE, form({ clipId: CLIP, reason: "No range" })))
      .toMatchObject({ status: "error", message: expect.stringContaining("Tick the confirmation") });
    expect(await submitFullSourceFallbackAction(FULL_SOURCE_FALLBACK_IDLE, form({ clipId: CLIP, reason: "  ", confirmed: "on" })))
      .toMatchObject({ status: "error", message: expect.stringContaining("reason") });
    expect(requestFullSourceFallback).not.toHaveBeenCalled();
  });

  it("passes the operator, clip, and trimmed reason and reports creation or reuse", async () => {
    expect(await submitFullSourceFallbackAction(FULL_SOURCE_FALLBACK_IDLE, form({ clipId: CLIP, reason: " No range. ", confirmed: "on" })))
      .toMatchObject({ status: "success", message: expect.stringContaining("queued") });
    expect(requestFullSourceFallback).toHaveBeenCalledWith({}, { clipId: CLIP, operatorUserId: "operator-1", reason: "No range." });
    (requestFullSourceFallback as Mock).mockResolvedValue({ ok: true, created: false, exportJobId: "e", fullSourceFallbackId: "f", editorialExceptionId: "x" });
    expect(await submitFullSourceFallbackAction(FULL_SOURCE_FALLBACK_IDLE, form({ clipId: CLIP, reason: "Again", confirmed: "on" })))
      .toMatchObject({ status: "success", message: expect.stringContaining("already queued") });
  });

  it("shows the server's refusal message", async () => {
    (requestFullSourceFallback as Mock).mockResolvedValue({ ok: false, status: 409, code: "FULL_SOURCE_FALLBACK_RANGE_AVAILABLE",
      message: "An approved media range covers this clip. Use the normal export." });
    expect(await submitFullSourceFallbackAction(FULL_SOURCE_FALLBACK_IDLE, form({ clipId: CLIP, reason: "r", confirmed: "on" })))
      .toEqual({ status: "error", message: "An approved media range covers this clip. Use the normal export." });
  });
});
