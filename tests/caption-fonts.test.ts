import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_CAPTION_FONTS,
  FONT_OPTIONS,
  PRESET_DEFAULT_FONT_VALUE,
  isBundledFontValue,
} from "@/lib/editor/caption-fonts";
import { CAPTION_PRESETS, getCaptionPreset } from "@/lib/editor/caption-presets";
import { TITLE_BANNER_FONT_FAMILY } from "@/lib/editor/title-banner";
import { resolveBundledFontFile } from "@/lib/export/font-metrics";

/**
 * A font choice is only honest if the same file draws the preview and the burn-in. Naming a family
 * the browser happens to have and the worker happens to have is not that: either can substitute,
 * silently, and the church publishes something it never saw.
 *
 * So the permitted faces are files in this repository, served to the browser and copied into the
 * worker image.
 */

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("bundled caption fonts", () => {
  it("ships every permitted face as a file in the repository", () => {
    expect(BUNDLED_CAPTION_FONTS.length).toBeGreaterThan(0);
    for (const font of BUNDLED_CAPTION_FONTS) {
      for (const file of [font.regularFile, font.boldFile]) {
        const full = path.join(root, "public", file);
        expect(existsSync(full), `${file} is missing`).toBe(true);
        // A real font, not a placeholder someone committed to make a test pass.
        expect(statSync(full).size, `${file} is too small to be a font`).toBeGreaterThan(50_000);
      }
    }
  });

  it("declares each face to the browser with @font-face", () => {
    const css = read("src/app/globals.css");
    for (const font of BUNDLED_CAPTION_FONTS) {
      expect(css, `${font.family} has no @font-face`).toContain(`font-family: "${font.family}"`);
      expect(css, `${font.regularFile} is not referenced`).toContain(font.regularFile);
      expect(css, `${font.boldFile} is not referenced`).toContain(font.boldFile);
    }
  });

  it("names the title's face in the worker image's own gate", () => {
    // The title has its own face, and the gate is what stops it being one the worker cannot draw.
    // Changing TITLE_BANNER_FONT_FAMILY to a family the gate does not check would otherwise ship a
    // title the preview renders and the burn-in silently substitutes another face for.
    const dockerfile = read("Dockerfile.worker");
    expect(
      dockerfile.includes(`"${TITLE_BANNER_FONT_FAMILY}"`),
      `the worker image does not check the title's face, ${TITLE_BANNER_FONT_FAMILY}`,
    ).toBe(true);
  });

  it("resolves the title's face to a file this repository actually ships", () => {
    // The runtime half of the same guarantee: the measurer opens a bundled file, or it throws
    // rather than measuring a substitute.
    for (const bold of [false, true]) {
      expect(
        resolveBundledFontFile(TITLE_BANNER_FONT_FAMILY, bold),
        `${TITLE_BANNER_FONT_FAMILY}${bold ? " bold" : ""} is not bundled`,
      ).toBeTruthy();
    }
  });

  it("copies the same files into the worker image and keeps the gate", () => {
    const dockerfile = read("Dockerfile.worker");
    expect(dockerfile, "the bundled fonts are not copied in").toMatch(/COPY .*fonts/);
    expect(dockerfile, "the font gate is gone").toMatch(/fc-match|fc-list/);

    // No font package is installed: two copies of a family means fontconfig chooses between them,
    // and the burn-in would draw a file the browser never loaded.
    const installed = dockerfile
      .split("\n")
      .filter((line) => line.includes("apt-get install"))
      .join(" ");
    expect(installed, "a distribution font package is installed").not.toMatch(/fonts-/);

    // ffmpeg pulls one in transitively regardless, so it has to be removed explicitly.
    expect(dockerfile, "the transitive copy is not removed").toContain(
      "rm -rf /usr/share/fonts/truetype/dejavu",
    );
  });

  it("offers only bundled families, plus an honest preset-default entry", () => {
    const families = BUNDLED_CAPTION_FONTS.map((font) => font.family);
    for (const option of FONT_OPTIONS) {
      expect(families, `${option.label} is not bundled`).toContain(option.rendersAs);
      expect(option.value).toContain(option.rendersAs);
    }
    expect(isBundledFontValue(PRESET_DEFAULT_FONT_VALUE)).toBe(false);
  });

  it("recognises a stored font that is not one of the explicit choices", () => {
    // Clean stores a stack this repository does not ship. The control must say so rather than
    // display a family the document does not use.
    expect(isBundledFontValue(getCaptionPreset("clean").style.fontFamily)).toBe(false);
    expect(isBundledFontValue(FONT_OPTIONS[0].value)).toBe(true);
  });

  it("leaves the stored font of Clean and every retired preset exactly as it was", () => {
    // Changing these changes what an approved clip renders, which is the whole point of not
    // touching them.
    expect(getCaptionPreset("clean").style.fontFamily).toBe("Inter, system-ui, sans-serif");
    expect(getCaptionPreset("bold-serif").style.fontFamily).toBe("Georgia, 'Times New Roman', serif");
    expect(getCaptionPreset("karaoke").style.fontFamily).toBe("Inter, system-ui, sans-serif");
    expect(getCaptionPreset("quiet").style.fontFamily).toBe("Inter, system-ui, sans-serif");
  });

  it("gives Highlighter a bundled default, because Highlighter is new", () => {
    const highlighter = getCaptionPreset("highlighter").style.fontFamily;
    expect(isBundledFontValue(highlighter)).toBe(true);
  });

  it("keeps every preset's font either bundled or untouched, never invented", () => {
    for (const preset of CAPTION_PRESETS) {
      const bundled = isBundledFontValue(preset.style.fontFamily);
      const legacy = preset.id !== "highlighter";
      expect(bundled || legacy, `${preset.id} has an unbundled new font`).toBe(true);
    }
  });
});
