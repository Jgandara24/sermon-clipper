"use client";

/**
 * The Audio row.
 *
 * Until Slice 11 draws real peaks, the bars are speech density from the transcript — computed by
 * `wordDensityBars`, never here — one bar per bucket across the window every row shares. The
 * source the clip excludes is dimmed exactly as it is on the other rows, so the three read as
 * one timeline.
 */
export function AudioTrack({
  bars,
  clipStartPct,
  clipEndPct,
}: {
  /** One height in 0..1 per bucket, left to right across the window. */
  bars: number[];
  clipStartPct: number;
  clipEndPct: number;
}) {
  return (
    <div
      data-testid="audio-track"
      role="img"
      aria-label="Where the speech is, from the transcript"
      className="relative h-full w-full overflow-hidden rounded-md bg-stone-100"
    >
      {bars.length > 0 ? (
        <svg
          className="absolute inset-0 h-full w-full text-teal-700"
          viewBox={`0 0 ${bars.length} 1`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {bars.map((height, index) =>
            height > 0 ? (
              <rect
                key={index}
                x={index + 0.15}
                y={1 - height}
                width={0.7}
                height={height}
                fill="currentColor"
                opacity={0.55}
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
