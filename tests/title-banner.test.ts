import { describe, expect, it } from "vitest";
import {
  createTitleBanner,
  dismissTitleBanner,
  ensureDefaultTitleBanner,
  readTitleBanner,
  removeTitleBanner,
  upsertTitleBanner,
} from "@/lib/editor/title-banner";

describe("title banner overlays", () => {
  it("adds and reads one title banner without changing unrelated overlays", () => {
    const banner = createTitleBanner({
      text: "Name One Person",
      startMs: 2_000,
      endMs: 8_000,
    });
    const overlays = upsertTitleBanner([{ type: "lowerThird", templateId: "brand-1" }], banner);

    expect(readTitleBanner(overlays)).toEqual(banner);
    expect(overlays[0]).toEqual({ type: "lowerThird", templateId: "brand-1" });
  });

  it("replaces and removes only the title banner", () => {
    const first = createTitleBanner({ text: "First", startMs: 0, endMs: 5_000 });
    const second = { ...first, text: "Second" };
    const overlays = upsertTitleBanner([first, { type: "future-overlay" }], second);

    expect(readTitleBanner(overlays)?.text).toBe("Second");
    expect(removeTitleBanner(overlays)).toEqual([{ type: "future-overlay" }]);
  });

  it("ignores malformed legacy overlay values", () => {
    expect(readTitleBanner([null, "old", { type: "titleBanner", text: 42 }])).toBeNull();
  });

  it("adds transform and border defaults to an older saved banner", () => {
    const banner = createTitleBanner({ text: "Legacy", startMs: 0, endMs: 2_000 });
    const legacy = {
      ...banner,
      positionX: undefined,
      positionY: undefined,
      borderWidthPx: undefined,
      borderColor: undefined,
    };

    expect(readTitleBanner([legacy])).toMatchObject({
      positionX: 50,
      positionY: 12,
      borderWidthPx: 0,
      borderColor: "#000000",
    });
  });

  it("creates the default title for the first three seconds of the clip", () => {
    const overlays = ensureDefaultTitleBanner([], {
      text: "Clip title",
      clipStartMs: 10_000,
      clipEndMs: 30_000,
    });

    expect(readTitleBanner(overlays)).toMatchObject({
      text: "Clip title",
      startMs: 10_000,
      endMs: 13_000,
    });
  });

  it("updates the older full-clip default to three seconds", () => {
    const oldDefault = createTitleBanner({
      text: "Clip title",
      startMs: 10_000,
      endMs: 30_000,
    });
    const overlays = ensureDefaultTitleBanner([oldDefault], {
      text: "Clip title",
      clipStartMs: 10_000,
      clipEndMs: 30_000,
    });

    expect(readTitleBanner(overlays)?.endMs).toBe(13_000);
  });

  it("does not recreate a title after the user removes it", () => {
    const dismissed = dismissTitleBanner([
      createTitleBanner({ text: "Clip title", startMs: 0, endMs: 3_000 }),
    ]);
    const overlays = ensureDefaultTitleBanner(dismissed, {
      text: "Clip title",
      clipStartMs: 0,
      clipEndMs: 10_000,
    });

    expect(readTitleBanner(overlays)).toBeNull();
    expect(readTitleBanner(upsertTitleBanner(overlays, createTitleBanner({
      text: "Added again",
      startMs: 0,
      endMs: 3_000,
    })))?.text).toBe("Added again");
  });
});
