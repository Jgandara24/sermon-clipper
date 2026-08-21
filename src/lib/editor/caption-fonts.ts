// Which fonts the caption picker may offer.
//
// The burn-in runs in the worker image, and libass can only use a face fontconfig can find there.
// Offering a face the image does not carry does not fail — it silently substitutes, so the church
// picks Georgia and gets something else in the file it publishes.
//
// The list below is what `fc-list` reports inside the built worker image. `Dockerfile.worker`
// installs those faces explicitly and fails the build if fontconfig stops resolving them, so this
// constant and the image cannot drift apart without CI saying so.

/** Exactly the families the worker image installs. Keep in step with the Dockerfile's gate. */
export const WORKER_INSTALLED_FONT_FAMILIES = [
  "DejaVu Sans",
  "DejaVu Serif",
  "DejaVu Sans Mono",
] as const;

export type CaptionFontOption = {
  /** The CSS stack the preview uses. */
  value: string;
  label: string;
  /** The family the worker actually renders with. Must be one the image installs. */
  rendersAs: (typeof WORKER_INSTALLED_FONT_FAMILIES)[number];
};

/**
 * Named for what they look like rather than for the file, because that is what the choice means to
 * someone picking one. The stack leads with the installed family so preview and burn-in agree
 * wherever the viewer has it, and falls back to the platform's own face where they do not.
 */
export const FONT_OPTIONS: CaptionFontOption[] = [
  {
    value: "'DejaVu Sans', system-ui, sans-serif",
    label: "Sans",
    rendersAs: "DejaVu Sans",
  },
  {
    value: "'DejaVu Serif', Georgia, serif",
    label: "Serif",
    rendersAs: "DejaVu Serif",
  },
  {
    value: "'DejaVu Sans Mono', ui-monospace, monospace",
    label: "Monospace",
    rendersAs: "DejaVu Sans Mono",
  },
];
