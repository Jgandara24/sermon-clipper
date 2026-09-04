"use client";

export type AudioBarsSource = "audio" | "transcript";

/**
 * The Audio row: one bar per bucket across the window every row shares, mirrored about the centre
 * line the way a waveform is drawn.
 *
 * The bars are real amplitude when the source's audio has been extracted, and speech density from
 * the transcript until then — reduced by `peakBars` and `wordDensityBars`, never here — and the
 * row says which it drew from. The source the clip excludes is dimmed exactly as it is on the
 * other rows, so the three read as one timeline.
 */
export function AudioTrack({
  bars,
  source,
  clipStartPct,
  clipEndPct,
}: {
  /** One height in 0..1 per bucket, left to right across the window. */
  bars: number[];
  source: AudioBarsSource;
  clipStartPct: number;
  clipEndPct: number;
}) {
  return (
    <div
      data-testid="audio-track"
      data-source={source}
      role="img"
      aria-label={
        source === "audio" ? "The sound of the source" : "Where the speech is, from the transcript"
      }
      className="relative h-full w-full overflow-hidden rounded-md bg-stone-100"
    >
      {bars.length > 0 ? (
        <svg
          className="absolute inset-0 h-full w-full text-teal-600"
          viewBox={`0 0 ${bars.length} 1`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {bars.map((height, index) =>
            height > 0 ? (
              <rect
                key={index}
                x={index + 0.15}
                y={(1 - height) / 2}
                width={0.7}
                height={height}
                fill="currentColor"
                opacity={0.85}
              />
            ) : null,
          )}
        </svg>
      ) : null}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 bg-stone-200/80"
        style={{ width: `${clipStartPct}%` }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 right-0 bg-stone-200/80"
        style={{ left: `${clipEndPct}%` }}
      />
    </div>
  );
}
