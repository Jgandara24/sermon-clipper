import { describe, expect, it } from "vitest";
import {
  TITLE_BANNER_DEFAULT_DURATION_MS,
  TITLE_BANNER_MIN_DURATION_MS,
  moveTitleRange,
  trimTitleRange,
  defaultTitleBanner,
  dismissTitleBanner,
  ensureDefaultTitleBanner,
  isTitleDismissed,
  readTitleBanner,
  removeTitleBanner,
  retimeTitleBanner,
  titleBannerSchema,
  upsertTitleBanner,
} from "@/lib/editor/title-banner";
import { editorStateSchema, buildDefaultEditorState } from "@/lib/editor/types";
import { safeAreaAnchorY } from "@/lib/editor/social-safe-area";

const CLIP = { startMs: 0, endMs: 12_000 };

/**
 * The title overlay's model.
 *
 * `overlays` has been `unknown[]` since the beginning and stored documents may carry anything at
 * all. A stricter parser that rejected an old shape would stop clips loading, so the rule is parse
 * leniently, write strictly: reading finds the one entry that is a title and steps over everything
 * else untouched, and writing validates.
 */
describe("a title is found in overlays without disturbing what else is there", () => {
  it("defaults to the first three seconds, top safe, centred, uppercase black on white", () => {
    const title = defaultTitleBanner(CLIP);

    expect(title.startMs).toBe(0);
    expect(title.endMs).toBe(TITLE_BANNER_DEFAULT_DURATION_MS);
    expect(title.anchor).toBe("top-safe");
    expect(title.align).toBe("center");
    expect(title.textCase).toBe("uppercase");
    expect(title.color).toBe("#000000");
    expect(title.backgroundColor).toBe("#FFFFFF");
    expect(title.border.widthPx).toBe(0);
    expect(title.shadow).toBe(false);
    expect(titleBannerSchema.parse(title)).toEqual(title);
  });

  it("takes its vertical place from the shared datum rather than a number of its own", () => {
    expect(defaultTitleBanner(CLIP).anchor).toBe("top-safe");
    expect(safeAreaAnchorY("top-safe")).toBeGreaterThan(0);
  });

  it("never defaults past the end of a clip shorter than the default", () => {
    const short = defaultTitleBanner({ startMs: 0, endMs: 1200 });
    expect(short.endMs).toBe(1200);
    expect(short.startMs).toBe(0);
  });

  it("starts where the clip starts, not where the timeline does", () => {
    const later = defaultTitleBanner({ startMs: 5_000, endMs: 20_000 });
    expect(later.startMs).toBe(5_000);
    expect(later.endMs).toBe(5_000 + TITLE_BANNER_DEFAULT_DURATION_MS);
  });

  it("reads nothing out of overlays that hold no title", () => {
    expect(readTitleBanner([])).toBeNull();
    expect(readTitleBanner([{ type: "lowerThird", headline: "x" }])).toBeNull();
    expect(readTitleBanner([null, 7, "text", { nested: { deep: true } }])).toBeNull();
  });

  it("steps over a malformed title rather than throwing", () => {
    // A document written by a future version, or corrupted, must not stop a clip loading.
    expect(readTitleBanner([{ type: "title" }])).toBeNull();
    expect(readTitleBanner([{ type: "title", id: "t", sizePx: "big" }])).toBeNull();
  });

  it("keeps every overlay it does not understand when a title is written", () => {
    const others = [{ type: "lowerThird", headline: "Grace" }, { type: "sticker", n: 3 }];
    const written = upsertTitleBanner(others, defaultTitleBanner(CLIP));

    expect(written).toHaveLength(3);
    expect(written).toEqual(expect.arrayContaining(others));
    expect(readTitleBanner(written)?.type).toBe("title");
  });

  it("replaces the title in place rather than adding a second one", () => {
    const first = upsertTitleBanner([], defaultTitleBanner(CLIP));
    const edited = { ...readTitleBanner(first)!, text: "SECOND" };
    const second = upsertTitleBanner(first, edited);

    expect(second.filter((o) => (o as { type?: string })?.type === "title")).toHaveLength(1);
    expect(readTitleBanner(second)?.text).toBe("SECOND");
  });

  it("refuses to write a title that does not validate", () => {
    const bad = { ...defaultTitleBanner(CLIP), sizePx: -4 };
    expect(() => upsertTitleBanner([], bad)).toThrow();
  });

  it("removes a title and leaves the rest of the overlays alone", () => {
    const others = [{ type: "lowerThird" }];
    const withTitle = upsertTitleBanner(others, defaultTitleBanner(CLIP));

    expect(readTitleBanner(removeTitleBanner(withTitle))).toBeNull();
    expect(removeTitleBanner(withTitle)).toEqual(others);
  });
});

/**
 * Removing and recreating.
 *
 * The behaviour is that X removes the title and selecting the empty Title track recreates the
 * default. That needs two different removals: one the member asked for, which must not come back
 * on its own, and one that leaves nothing behind.
 */
describe("a title the member dismissed does not come back on its own", () => {
  it("adds the default when there is no title and none was dismissed", () => {
    const ensured = ensureDefaultTitleBanner([], CLIP);
    expect(readTitleBanner(ensured)?.endMs).toBe(TITLE_BANNER_DEFAULT_DURATION_MS);
  });

  it("leaves an existing title exactly as it is", () => {
    const mine = { ...defaultTitleBanner(CLIP), text: "MINE", sizePx: 99 };
    const overlays = upsertTitleBanner([], mine);
    expect(readTitleBanner(ensureDefaultTitleBanner(overlays, CLIP))).toEqual(mine);
  });

  it("does not put one back after it was dismissed", () => {
    const dismissed = dismissTitleBanner(upsertTitleBanner([], defaultTitleBanner(CLIP)));

    expect(readTitleBanner(dismissed)).toBeNull();
    expect(isTitleDismissed(dismissed)).toBe(true);
    expect(readTitleBanner(ensureDefaultTitleBanner(dismissed, CLIP))).toBeNull();
  });

  it("comes back when the member asks for it, and stops being dismissed", () => {
    // Selecting the empty Title track is an explicit ask, so it overrides the dismissal.
    const dismissed = dismissTitleBanner(upsertTitleBanner([], defaultTitleBanner(CLIP)));
    const again = upsertTitleBanner(dismissed, defaultTitleBanner(CLIP));

    expect(readTitleBanner(again)).not.toBeNull();
    expect(isTitleDismissed(again)).toBe(false);
    expect(readTitleBanner(ensureDefaultTitleBanner(again, CLIP))).not.toBeNull();
  });

  it("treats a plain removal as leaving room for the default again", () => {
    const removed = removeTitleBanner(upsertTitleBanner([], defaultTitleBanner(CLIP)));
    expect(isTitleDismissed(removed)).toBe(false);
    expect(readTitleBanner(ensureDefaultTitleBanner(removed, CLIP))).not.toBeNull();
  });
});

describe("dragging and trimming the title's range", () => {
  const CLIP_RANGE = { startMs: 1_000, endMs: 11_000 };
  const RANGE = { startMs: 2_000, endMs: 5_000 };

  it("moves the whole title, keeping its length", () => {
    expect(moveTitleRange(RANGE, 1_500, CLIP_RANGE)).toEqual({ startMs: 3_500, endMs: 6_500 });
    expect(moveTitleRange(RANGE, -500, CLIP_RANGE)).toEqual({ startMs: 1_500, endMs: 4_500 });
  });

  it("stops at the clip's edges rather than being shortened by them", () => {
    // A title dragged past the end that lost its length on the way would come back a different
    // length, which is not what dragging something means.
    const early = moveTitleRange(RANGE, -10_000, CLIP_RANGE);
    expect(early).toEqual({ startMs: 1_000, endMs: 4_000 });

    const late = moveTitleRange(RANGE, 10_000, CLIP_RANGE);
    expect(late.endMs).toBe(CLIP_RANGE.endMs);
    expect(late.endMs - late.startMs).toBe(RANGE.endMs - RANGE.startMs);
  });

  it("keeps a title longer than the clip from moving at all", () => {
    const whole = { startMs: 1_000, endMs: 11_000 };
    expect(moveTitleRange(whole, 5_000, CLIP_RANGE)).toEqual(whole);
  });

  it("trims one end without moving the other", () => {
    expect(trimTitleRange(RANGE, "start", 3_000, CLIP_RANGE)).toEqual({
      startMs: 3_000,
      endMs: 5_000,
    });
    expect(trimTitleRange(RANGE, "end", 4_000, CLIP_RANGE)).toEqual({
      startMs: 2_000,
      endMs: 4_000,
    });
  });

  it("will not let the two ends cross", () => {
    const crossed = trimTitleRange(RANGE, "start", 9_000, CLIP_RANGE);
    expect(crossed.startMs).toBe(RANGE.endMs - TITLE_BANNER_MIN_DURATION_MS);
    expect(crossed.endMs).toBe(RANGE.endMs);

    const other = trimTitleRange(RANGE, "end", 0, CLIP_RANGE);
    expect(other.endMs).toBe(RANGE.startMs + TITLE_BANNER_MIN_DURATION_MS);
  });

  it("never trims outside the clip", () => {
    expect(trimTitleRange(RANGE, "start", -5_000, CLIP_RANGE).startMs).toBe(CLIP_RANGE.startMs);
    expect(trimTitleRange(RANGE, "end", 99_000, CLIP_RANGE).endMs).toBe(CLIP_RANGE.endMs);
  });
});

describe("a title moves onto the timeline the file actually plays", () => {
  it("remaps both ends through the same map the captions use", () => {
    // Every time in the document is on the source timeline. The rendered file plays the kept
    // ranges concatenated, so a title left on the source timeline drifts by whatever was cut
    // before it.
    const title = { ...defaultTitleBanner({ startMs: 8_000, endMs: 20_000 }) };
    const retimed = retimeTitleBanner(title, (ms) => ms - 5_000);

    expect(retimed.startMs).toBe(3_000);
    expect(retimed.endMs).toBe(6_000);
  });

  it("changes nothing but the times", () => {
    const title = { ...defaultTitleBanner(CLIP), text: "GRACE", sizePx: 96 };
    const retimed = retimeTitleBanner(title, (ms) => ms + 100);
    expect({ ...retimed, startMs: title.startMs, endMs: title.endMs }).toEqual(title);
  });
});

describe("stored documents keep parsing", () => {
  it("accepts a document whose overlays hold a title", () => {
    const state = buildDefaultEditorState({ sourceVideoId: "v", startMs: 0, endMs: 12_000 });
    state.overlays = upsertTitleBanner([], defaultTitleBanner(CLIP));
    expect(() => editorStateSchema.parse(state)).not.toThrow();
  });

  it("accepts documents written before titles existed", () => {
    const state = buildDefaultEditorState({ sourceVideoId: "v", startMs: 0, endMs: 12_000 });
    for (const overlays of [[], [{ type: "lowerThird" }], [null, 4, "x"]]) {
      expect(() => editorStateSchema.parse({ ...state, overlays })).not.toThrow();
    }
  });

  it("starts a new clip with no title at all", () => {
    // A default document is what a version-0 clip is rendered from, so putting a title here would
    // add one to every clip that exists and was never edited.
    const state = buildDefaultEditorState({ sourceVideoId: "v", startMs: 0, endMs: 12_000 });
    expect(state.overlays).toEqual([]);
    expect(readTitleBanner(state.overlays)).toBeNull();
  });
});
