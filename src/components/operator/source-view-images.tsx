"use client";
import { useState } from "react";
import Image from "next/image";
import type { SourceViewImage } from "@/lib/media/source-view-images";

function timestamp(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
export function SourceViewImages({ images }: { images: SourceViewImage[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!images.length) return null;
  return <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm" data-testid="source-view-images">
    <h2 className="font-semibold">Source images</h2>
    <p className="mt-2 text-sm text-stone-600">These images show selected moments. Review the video between them.</p>
    <div className="mt-3 grid gap-3">{images.map((image, index) => {
      const title = image.kind === "TIMELINE_VIEW" ? "Timeline" : "Boundary frames";
      return <div key={image.id}>
        <button type="button" className="text-sm text-teal-800 underline" aria-expanded={openId === image.id}
          data-testid="source-view-toggle" onClick={() => setOpenId(openId === image.id ? null : image.id)}>
          {openId === image.id ? "Hide" : "Show"} {title.toLowerCase()} {index + 1}
        </button>
        {openId === image.id ? <figure className="mt-3">
          <Image src={image.url} alt={title} width={image.width} height={image.height} unoptimized
            data-testid="source-view-image" className="h-auto max-w-full" />
          <figcaption className="mt-2 text-sm text-stone-600">
            <p>Frames run left to right, then top to bottom.</p>
            <ol className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{image.sourceTimesMs.map((ms, cell) =>
              <li key={ms}>{cell + 1}: {timestamp(ms)}</li>)}</ol>
          </figcaption>
        </figure> : null}
      </div>;
    })}</div>
  </section>;
}
