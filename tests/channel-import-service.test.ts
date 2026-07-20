import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  ChannelImportInputError,
  normalizeChannelInput,
  registerChannelImportSource,
  setChannelImportSourceEnabled,
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

describe("setChannelImportSourceEnabled denial paths", () => {
  function clientWithSource(source: { id: string; workspaceId: string } | null) {
    let updateCalls = 0;
    const client = {
      channelImportSource: {
        findUnique: async () => source,
        update: async () => {
          updateCalls += 1;
          return source;
        },
      },
    } as unknown as PrismaClient;
    return { client, updateCount: () => updateCalls };
  }

  it("throws ChannelImportInputError for a nonexistent source id", async () => {
    const { client, updateCount } = clientWithSource(null);

    await expect(
      setChannelImportSourceEnabled(client, "ws-1", "source-1", false),
    ).rejects.toThrow(ChannelImportInputError);
    expect(updateCount()).toBe(0);
  });

  it("throws the same ChannelImportInputError for a source in another workspace", async () => {
    const { client, updateCount } = clientWithSource({ id: "source-1", workspaceId: "ws-other" });

    await expect(
      setChannelImportSourceEnabled(client, "ws-1", "source-1", false),
    ).rejects.toThrow("That channel registration no longer exists.");
    expect(updateCount()).toBe(0);
  });

  it("updates the source when it belongs to the workspace", async () => {
    const { client, updateCount } = clientWithSource({ id: "source-1", workspaceId: "ws-1" });

    await setChannelImportSourceEnabled(client, "ws-1", "source-1", true);
    expect(updateCount()).toBe(1);
  });
});
