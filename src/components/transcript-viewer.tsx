"use client";

import { useEffect, useState } from "react";

type TranscriptSegment = {
  id: string;
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
};

type TranscriptState = {
  transcript: { id: string; language: string; provider: string } | null;
  segments: TranscriptSegment[];
};

function formatTimestamp(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

async function fetchTranscript(sourceVideoId: string): Promise<TranscriptState | null> {
  const res = await fetch(`/api/videos/${sourceVideoId}/transcript`, { cache: "no-store" });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data as TranscriptState;
}

export function TranscriptViewer({
  sourceVideoId,
  transcriptionUnavailable,
}: {
  sourceVideoId: string;
  transcriptionUnavailable?: boolean;
}) {
  const [state, setState] = useState<TranscriptState>({ transcript: null, segments: [] });
  const [search, setSearch] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const next = await fetchTranscript(sourceVideoId);
      if (cancelled || !next) return;
      setState(next);
      if (next.segments.length > 0) {
        clearInterval(interval);
      }
    }

    tick();
    const interval = setInterval(tick, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sourceVideoId]);

  async function handleSrtUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    setUploadError(null);
    try {
      const text = await file.text();
      const res = await fetch(`/api/videos/${sourceVideoId}/srt`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: text,
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message ?? "That SRT file couldn't be uploaded.");
      }
      setTimeout(() => {
        fetchTranscript(sourceVideoId).then((next) => next && setState(next));
      }, 1500);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "That SRT file couldn't be uploaded.");
    } finally {
      setIsUploading(false);
      event.target.value = "";
    }
  }

  const filteredSegments = search.trim()
    ? state.segments.filter((segment) =>
        segment.text.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : state.segments;

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Transcript</h2>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search transcript"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="rounded-md border border-stone-300 px-2 py-1 text-sm outline-none focus:border-teal-700"
          />
          <label className="cursor-pointer rounded-md border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50">
            {isUploading ? "Uploading…" : "Upload SRT"}
            <input
              type="file"
              accept=".srt"
              onChange={handleSrtUpload}
              className="hidden"
              disabled={isUploading}
            />
          </label>
        </div>
      </div>

      {uploadError ? (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          {uploadError}
        </p>
      ) : null}

      {transcriptionUnavailable && !state.transcript ? (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Local speech-to-text is not configured for this environment. Upload an SRT file here to
          keep going with clip analysis.
        </p>
      ) : null}

      {state.transcript ? (
        <p className="mt-2 text-xs text-stone-500">
          {state.transcript.language.toUpperCase()} · {state.transcript.provider}
        </p>
      ) : null}

      <div className="mt-4 max-h-96 space-y-2 overflow-y-auto">
        {filteredSegments.map((segment) => (
          <div key={segment.id} className="flex gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50">
            <span className="w-12 shrink-0 text-xs tabular-nums text-stone-400">
              {formatTimestamp(segment.startMs)}
            </span>
            <p className="text-sm text-stone-700">{segment.text}</p>
          </div>
        ))}
        {state.segments.length === 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            No transcript yet — it will appear once the transcribe stage finishes.
          </p>
        ) : filteredSegments.length === 0 ? (
          <p className="text-sm text-stone-500">No segments match &quot;{search}&quot;.</p>
        ) : null}
      </div>
    </div>
  );
}
