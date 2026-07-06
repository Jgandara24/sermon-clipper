"use client";

import { useState, useTransition } from "react";
import { createProjectFromUploadAction } from "@/app/actions/projects";

type UploadStage = "idle" | "uploading" | "finalizing" | "error";

type PresignResponse = { data: { uploadId: string; uploadUrl: string } };
type CompleteResponse = { data: { sourceVideoId: string } };
type ApiErrorResponse = { error: { message: string } };

async function parseJsonOrThrow<T>(response: Response, fallbackMessage: string): Promise<T> {
  const json = (await response.json().catch(() => null)) as (T & ApiErrorResponse) | null;
  if (!response.ok || !json) {
    throw new Error((json as ApiErrorResponse | null)?.error?.message ?? fallbackMessage);
  }
  return json;
}

export function UploadDropzone() {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [series, setSeries] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [stage, setStage] = useState<UploadStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    if (selected && !name) {
      setName(selected.name.replace(/\.[^./]+$/, ""));
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("Choose a video file first.");
      return;
    }

    setError(null);
    setStage("uploading");

    try {
      const presignRes = await fetch("/api/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, size: file.size, type: file.type }),
      });
      const presignJson = await parseJsonOrThrow<PresignResponse>(
        presignRes,
        "Could not start the upload.",
      );
      const { uploadId, uploadUrl } = presignJson.data;

      const putRes = await fetch(uploadUrl, { method: "PUT", body: file });
      await parseJsonOrThrow(putRes, "Upload lost connection — resume?");

      setStage("finalizing");
      const completeRes = await fetch(`/api/uploads/${uploadId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, size: file.size, type: file.type }),
      });
      const completeJson = await parseJsonOrThrow<CompleteResponse>(
        completeRes,
        "Could not finish the upload.",
      );

      const formData = new FormData();
      formData.set("sourceVideoId", completeJson.data.sourceVideoId);
      formData.set("name", name || file.name);
      formData.set("series", series);
      formData.set("speaker", speaker);

      startTransition(() => {
        createProjectFromUploadAction(formData);
      });
    } catch (submitError) {
      setStage("error");
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
    }
  }

  const busy = stage === "uploading" || stage === "finalizing" || isPending;

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <div>
        <label htmlFor="video-file" className="text-sm font-medium">
          Video file
        </label>
        <input
          id="video-file"
          type="file"
          accept="video/*"
          onChange={handleFileChange}
          disabled={busy}
          className="mt-2 block w-full text-sm text-stone-600 file:mr-4 file:rounded-md file:border-0 file:bg-teal-700 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-teal-800 disabled:opacity-50"
        />
        {file ? (
          <p className="mt-1 text-xs text-stone-500">
            {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor="upload-name" className="text-sm font-medium">
          Project name
        </label>
        <input
          id="upload-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
          required
          placeholder="Sunday Morning Message"
          className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100 disabled:opacity-50"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <input
          value={series}
          onChange={(event) => setSeries(event.target.value)}
          disabled={busy}
          placeholder="Series"
          className="rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100 disabled:opacity-50"
        />
        <input
          value={speaker}
          onChange={(event) => setSpeaker(event.target.value)}
          disabled={busy}
          placeholder="Speaker"
          className="rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100 disabled:opacity-50"
        />
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>
      ) : null}

      <button
        type="submit"
        disabled={busy || !file}
        className="rounded-md bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {stage === "uploading"
          ? "Uploading…"
          : stage === "finalizing" || isPending
            ? "Starting processing…"
            : "Upload & process"}
      </button>
    </form>
  );
}
