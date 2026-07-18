import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  ChannelImportInputError,
  normalizeChannelInput,
  registerChannelImportSource,
} from "@/lib/channel-import-service";

const CHANNEL_ID = "UCAOHpXtnB1c9BW7hqLg-3gQ";

describe("normalizeChannelInput", () => {
  it("passes @handles through and prefixes bare handles", () => {
    expect(normalizeChannelInput("@gracechurch")).toBe("@gracechurch");
    expect(normalizeChannelInput("gracechurch")).toBe("@gracechurch");
    expect(normalizeChannelInput("  @gracechurch  ")).toBe("@gracechurch");
  });

  it("passes raw UC... channel ids through", () => {
    expect(normalizeChannelInput(CHANNEL_ID)).toBe(CHANNEL_ID);
  });

  it("extracts the handle or channel id from youtube.com channel URLs", () => {
    expect(normalizeChannelInput("https://www.youtube.com/@gracechurch")).toBe("@gracechurch");
    expect(normalizeChannelInput("https://youtube.com/@gracechurch/videos")).toBe("@gracechurch");
    expect(normalizeChannelInput("www.youtube.com/@gracechurch")).toBe("@gracechurch");
    expect(normalizeChannelInput(`https://www.youtube.com/channel/${CHANNEL_ID}`)).toBe(CHANNEL_ID);
  });

  it("rejects empty input", () => {
    expect(() => normalizeChannelInput("")).toThrow(ChannelImportInputError);
    expect(() => normalizeChannelInput("   ")).toThrow(ChannelImportInputError);
  });

  it("rejects legacy /c/ and /user/ URLs with guidance", () => {
    expect(() => normalizeChannelInput("https://www.youtube.com/c/GraceChurch")).toThrow(
      ChannelImportInputError,
    );
    expect(() => normalizeChannelInput("https://www.youtube.com/user/gracechurch")).toThrow(
      ChannelImportInputError,
    );
  });

  it("rejects youtube.com URLs that are not channels", () => {
    expect(() => normalizeChannelInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toThrow(
      ChannelImportInputError,
    );
    expect(() => normalizeChannelInput("https://www.youtube.com/")).toThrow(ChannelImportInputError);
  });

  it("rejects non-YouTube URLs and garbage", () => {
    expect(() => normalizeChannelInput("https://vimeo.com/gracechurch")).toThrow(
      ChannelImportInputError,
    );
    expect(() => normalizeChannelInput("not a channel!!")).toThrow(ChannelImportInputError);
    expect(() => normalizeChannelInput("@x")).toThrow(ChannelImportInputError);
  });
});

describe("registerChannelImportSource input rejection", () => {
  it("rejects bad input before touching the resolver or the database", async () => {
    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls += 1;
      throw new Error("resolver must not be called for bad input");
    };
    // Sentinel: any property access means the service touched the DB for bad input.
    const client = new Proxy({} as PrismaClient, {
      get() {
        throw new Error("database must not be touched for bad input");
      },
    });

    await expect(
      registerChannelImportSource(client, "workspace-id", "https://vimeo.com/x", resolver),
    ).rejects.toThrow(ChannelImportInputError);
    expect(resolverCalls).toBe(0);
  });
});
