// Which fonts the caption picker may offer.
//
// A font choice is only honest if the same file draws the preview and the burn-in. Naming a family
// the browser happens to have and the worker happens to have is not that — either can substitute
// silently, and the church publishes something it never saw. libass in particular never fails on a
// missing face; it just picks another one.
//
// So the permitted faces are files in this repository. `public/fonts` is served to the browser and
// declared with `@font-face` in globals.css, and `Dockerfile.worker` copies the same directory into
// the image and fails the build if fontconfig stops resolving any of them.
//
// The presets that predate this deliberately keep their original stacks. Their stored font is what
// an approved clip renders with, and changing it changes that clip.

export type BundledCaptionFont = {
  /** The family name the files declare, and the name both renderers ask for. */
  family: string;
  /** Paths relative to `public/`, so the browser URL is `/` + the path. */
  regularFile: string;
  boldFile: string;
};

export const BUNDLED_CAPTION_FONTS: BundledCaptionFont[] = [
  {
    family: "DejaVu Sans",
    regularFile: "fonts/DejaVuSans.ttf",
    boldFile: "fonts/DejaVuSans-Bold.ttf",
  },
  {
    family: "DejaVu Serif",
    regularFile: "fonts/DejaVuSerif.ttf",
    boldFile: "fonts/DejaVuSerif-Bold.ttf",
  },
  {
    family: "DejaVu Sans Mono",
    regularFile: "fonts/DejaVuSansMono.ttf",
    boldFile: "fonts/DejaVuSansMono-Bold.ttf",
  },
];

/** The families the worker image must carry. Kept in step with the Dockerfile's gate. */
export const WORKER_INSTALLED_FONT_FAMILIES = BUNDLED_CAPTION_FONTS.map((font) => font.family);

export type CaptionFontOption = {
  /** The CSS stack the preview uses, leading with the bundled family. */
  value: string;
  label: string;
  /** The family that actually draws it, in the browser and in the image alike. */
  rendersAs: string;
};

/**
 * Named for what they look like rather than for the file, because that is what the choice means to
 * someone picking one.
 */
export const FONT_OPTIONS: CaptionFontOption[] = [
  { value: "'DejaVu Sans', sans-serif", label: "Sans", rendersAs: "DejaVu Sans" },
  { value: "'DejaVu Serif', serif", label: "Serif", rendersAs: "DejaVu Serif" },
  { value: "'DejaVu Sans Mono', monospace", label: "Monospace", rendersAs: "DejaVu Sans Mono" },
];

/**
 * What the picker shows for a document whose stored font is none of the explicit choices — every
 * clip made against Clean or a retired preset. Selecting it changes nothing; it exists so the
 * control can say "the preset's own font" instead of naming a family the document does not use.
 */
export const PRESET_DEFAULT_FONT_VALUE = "__preset_default__";

export function isBundledFontValue(value: string | undefined): boolean {
  if (!value) return false;
  return FONT_OPTIONS.some((option) => option.value === value);
}
