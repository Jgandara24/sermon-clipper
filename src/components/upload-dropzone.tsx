"use client";

import { useRef, useState, useTransition } from "react";
import { cancelBrowserUpload, uploadBrowserVideo, type BrowserUploadAttempt } from "@/lib/uploads/browser-upload";
import { createProjectFromUploadAction } from "@/app/actions/projects";

type UploadStage = "idle" | "uploading" | "finalizing" | "canceling" | "error";

export function UploadDropzone() {
  const uploadAttempt = useRef<BrowserUploadAttempt | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const uploadPromise = useRef<Promise<string> | null>(null);
  const canceling = useRef(false);
  const [multipart, setMultipart] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadComplete, setUploadComplete] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [series, setSeries] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [stage, setStage] = useState<UploadStage>("idle");
  const [sermonDate, setSermonDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [serviceOccurrence, setServiceOccurrence] = useState<"PRIMARY" | "SECONDARY" | "UNMATCHED">(
    "PRIMARY",
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    uploadAttempt.current = null;
    setMultipart(false);
    setProgress(0);
    setError(null);
    setUploadComplete(false);
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

    const controller = new AbortController();
    uploadController.current = controller;
    try {
      const pending = uploadBrowserVideo(file, {
        attempt: uploadAttempt.current,
        signal: controller.signal,
        onAttempt: attempt => { uploadAttempt.current = attempt; setMultipart(attempt.registration.transport === "multipart"); },
        onProgress: (uploaded, total) => setProgress(total ? Math.floor(uploaded * 100 / total) : 0),
        onStage: next => { if (!canceling.current) setStage(next); },
      });
      uploadPromise.current = pending;
      const sourceVideoId = await pending;
      setUploadComplete(true);
      if (canceling.current) return;

      const formData = new FormData();
      formData.set("sourceVideoId", sourceVideoId);
      formData.set("name", name || file.name);
      formData.set("series", series);
      formData.set("speaker", speaker);
      formData.set("sermonDate", sermonDate);
      formData.set("serviceOccurrence", serviceOccurrence);

      startTransition(() => {
        createProjectFromUploadAction(formData);
      });
    } catch (submitError) {
      if (canceling.current) return;
      setStage("error");
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
    } finally {
      uploadController.current = null;
      uploadPromise.current = null;
    }
  }

  async function handleCancel() {
    if (canceling.current) return;
    canceling.current = true;
    setStage("canceling");
    setError(null);
    uploadController.current?.abort();
    try {
      await uploadPromise.current?.catch(() => undefined);
      const attempt = uploadAttempt.current;
      if (attempt) await cancelBrowserUpload(attempt);
      uploadAttempt.current = null;
      setMultipart(false);
      setProgress(0);
      setStage("idle");
    } catch (cancelError) {
      setStage("error");
      setError(cancelError instanceof Error ? cancelError.message : "Could not confirm cancellation.");
    } finally { canceling.current = false; }
  }

  const busy = stage === "uploading" || stage === "finalizing" || stage === "canceling" || isPending;

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

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="upload-sermon-date" className="text-sm font-medium">
            Service date
          </label>
          <input
            id="upload-sermon-date"
            type="date"
            value={sermonDate}
            onChange={(event) => setSermonDate(event.target.value)}
            disabled={busy}
            required
            className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100 disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-stone-500">
            The day the service happened, not the day you are uploading it.
          </p>
        </div>
        <div>
          <label htmlFor="upload-service-occurrence" className="text-sm font-medium">
            Which service
          </label>
          <select
            id="upload-service-occurrence"
            value={serviceOccurrence}
            onChange={(event) =>
              setServiceOccurrence(event.target.value as "PRIMARY" | "SECONDARY" | "UNMATCHED")
            }
            disabled={busy}
            className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100 disabled:opacity-50"
          >
            <option value="PRIMARY">Main weekly service</option>
            <option value="SECONDARY">Second weekly service</option>
            <option value="UNMATCHED">Special service</option>
          </select>
          <p className="mt-1 text-xs text-stone-500">
            A special service is clipped but never scheduled automatically.
          </p>
        </div>
      </div>

      {multipart && (stage === "uploading" || stage === "finalizing" || stage === "canceling") ? (
        <div className="grid gap-1">
          <label htmlFor="upload-progress" className="text-sm">Uploaded {progress}%</label>
          <progress id="upload-progress" value={progress} max={100} className="w-full" />
        </div>
      ) : null}
      {multipart && (stage === "uploading" || stage === "error" || stage === "canceling") && !uploadComplete ? (
        <button type="button" onClick={handleCancel} disabled={stage === "canceling"}
          className="rounded-md border border-stone-300 px-4 py-2 text-sm disabled:opacity-50">
          {stage === "canceling" ? "Canceling upload…" : "Cancel upload"}
        </button>
      ) : null}

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>
      ) : null}

      <button
        type="submit"
        disabled={busy || !file}
        className="rounded-md bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {stage === "canceling" ? "Canceling upload…" : stage === "uploading"
          ? "Uploading…"
          : stage === "finalizing" || isPending
            ? "Starting processing…"
            : "Upload & process"}
      </button>
    </form>
  );
}
