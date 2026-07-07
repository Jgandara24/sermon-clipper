import { describe, expect, it, vi } from "vitest";
import {
  createSignedMediaUrl,
  createSignedUploadUrl,
  verifySignedMediaUrl,
  verifySignedUploadUrl,
} from "@/lib/media/signed-url";

describe("signed media URLs", () => {
  it("verifies untampered short-lived media URLs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00Z"));
    const url = createSignedMediaUrl({
      key: "exports/workspace-1/export.mp4",
      workspaceId: "workspace-1",
      contentType: "video/mp4",
      filename: "clip.mp4",
      disposition: "attachment",
    });

    const verified = verifySignedMediaUrl(new URL(`http://localhost${url}`).searchParams);

    expect(verified).toMatchObject({
      ok: true,
      key: "exports/workspace-1/export.mp4",
      workspaceId: "workspace-1",
      contentType: "video/mp4",
      filename: "clip.mp4",
      disposition: "attachment",
    });
    vi.useRealTimers();
  });

  it("rejects tampered media URLs", () => {
    const url = createSignedMediaUrl({
      key: "exports/workspace-1/export.mp4",
      workspaceId: "workspace-1",
    });
    const parsed = new URL(`http://localhost${url}`);
    parsed.searchParams.set("key", "exports/workspace-2/export.mp4");

    expect(verifySignedMediaUrl(parsed.searchParams)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects expired upload URLs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00Z"));
    const url = createSignedUploadUrl({
      uploadId: "upload-1",
      workspaceId: "workspace-1",
      maxBytes: 1024,
      expiresInSeconds: 60,
    });

    vi.setSystemTime(new Date("2026-07-07T12:02:00Z"));
    const parsed = new URL(`http://localhost${url}`);

    expect(verifySignedUploadUrl("upload-1", parsed.searchParams)).toEqual({
      ok: false,
      reason: "expired",
    });
    vi.useRealTimers();
  });

  it("binds upload signatures to the upload id", () => {
    const url = createSignedUploadUrl({ uploadId: "upload-1", workspaceId: "workspace-1", maxBytes: 1024 });
    const parsed = new URL(`http://localhost${url}`);

    expect(verifySignedUploadUrl("upload-2", parsed.searchParams)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("binds upload signatures to the plan byte limit", () => {
    const url = createSignedUploadUrl({ uploadId: "upload-1", workspaceId: "workspace-1", maxBytes: 1024 });
    const parsed = new URL(`http://localhost${url}`);
    expect(verifySignedUploadUrl("upload-1", parsed.searchParams)).toMatchObject({
      ok: true,
      maxBytes: 1024,
    });

    parsed.searchParams.set("maxBytes", "2048");
    expect(verifySignedUploadUrl("upload-1", parsed.searchParams)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
