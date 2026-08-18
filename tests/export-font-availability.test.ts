import { describe, expect, it } from "vitest";
import { CAPTION_FONTS } from "@/lib/editor/fonts";
import { missingCaptionFontFiles } from "@/lib/export/font-metrics";

// The worker readiness gate reports missing caption fonts as degraded so a font-less worker
// still transcribes, probes, analyzes, and finalizes. The export path is the one job type the
// fonts actually gate, so it must refuse the render itself rather than burn a fallback face.
describe("missingCaptionFontFiles", () => {
  it("returns nothing when every shipped face is readable", () => {
    expect(missingCaptionFontFiles(`${process.cwd()}/public/fonts`)).toEqual([]);
  });

  it("names every unreadable face so the failure says what is missing", () => {
    const missing = missingCaptionFontFiles("/nowhere/fonts");
    const shipped = CAPTION_FONTS.flatMap((font) => Object.values(font.files));
    expect(missing).toEqual(shipped);
  });

  it("reports only the faces that are actually absent", () => {
    const missing = missingCaptionFontFiles(`${process.cwd()}/public/fonts`, (filePath) =>
      !filePath.endsWith("Poppins-Bold.ttf"),
    );
    expect(missing).toEqual(["Poppins-Bold.ttf"]);
  });
});
