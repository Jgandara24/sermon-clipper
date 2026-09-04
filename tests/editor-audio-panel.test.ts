import { describe, expect, it } from "vitest";
import { volumeToPercent } from "@/components/editor/audio-panel";

describe("the Audio panel's percent", () => {
  it("shows the document's factor as a whole percent of the source's level", () => {
    expect(volumeToPercent(1)).toBe(100);
    expect(volumeToPercent(0.4)).toBe(40);
    expect(volumeToPercent(0)).toBe(0);
  });

  it("stops at 100, because the preview cannot play louder than the source", () => {
    // The schema allows a factor of 2; a document carrying one is shown at the control's ceiling.
    expect(volumeToPercent(2)).toBe(100);
    expect(volumeToPercent(1.5)).toBe(100);
  });

  it("treats nonsense as silence rather than NaN", () => {
    expect(volumeToPercent(Number.NaN)).toBe(0);
  });
});
