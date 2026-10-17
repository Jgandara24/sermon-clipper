export type UploadRegistration =
  | { transport: "multipart"; uploadId: string; partBytes: number; totalBytes: number }
  | { transport?: "relay"; uploadId: string; uploadUrl: string };
export type BrowserUploadAttempt = { registration: UploadRegistration; uploaded: boolean; sourceVideoId?: string };

async function json<T>(response: Response, fallback: string): Promise<T> {
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.data) throw new Error(result?.error?.message ?? fallback);
  return result.data as T;
}
async function control<T>(uploadId: string, action: object, signal?: AbortSignal) {
  return json<T>(await fetch(`/api/uploads/${encodeURIComponent(uploadId)}/multipart`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action),
    ...(signal ? { signal } : {}),
  }), "The upload request failed.");
}

/** The component retains this attempt for the same File. A lost completion response reuses the upload ID. */
export async function uploadBrowserVideo(file: File, input: {
  attempt: BrowserUploadAttempt | null;
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  onAttempt: (attempt: BrowserUploadAttempt) => void;
  onStage: (stage: "uploading" | "finalizing") => void;
}): Promise<string> {
  input.signal?.throwIfAborted();
  const signalOption = input.signal ? { signal: input.signal } : {};
  let attempt = input.attempt;
  if (!attempt) {
    const registration = await json<UploadRegistration>(await fetch("/api/uploads/presign", {
      method: "POST", headers: { "Content-Type": "application/json" }, ...signalOption,
      body: JSON.stringify({ filename: file.name, size: file.size, type: file.type }),
    }), "Could not start the upload.");
    attempt = { registration, uploaded: false };
    input.onAttempt(attempt);
  }
  input.signal?.throwIfAborted();
  input.onProgress?.(attempt.uploaded ? file.size : 0, file.size);
  if (attempt.sourceVideoId) return attempt.sourceVideoId;
  const registration = attempt.registration;
  if (!attempt.uploaded) {
    input.onStage("uploading");
    if (registration.transport === "multipart") {
      if (!Number.isSafeInteger(registration.partBytes) || registration.partBytes <= 0 ||
          registration.totalBytes !== file.size || Math.ceil(file.size / registration.partBytes) > 10_000) {
        throw new Error("The upload size does not match this file.");
      }
      await control(registration.uploadId, { action: "start" }, input.signal);
      const stored = await control<{ parts: { partNumber: number; byteCount: number }[] }>(registration.uploadId,
        { action: "list" }, input.signal);
      const present = new Set<number>();
      let confirmedBytes = 0;
      const partCount = Math.ceil(file.size / registration.partBytes);
      if (!Array.isArray(stored.parts) || stored.parts.length > partCount) throw new Error("The stored upload parts are invalid.");
      for (const part of stored.parts) {
        if (!part || !Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > partCount ||
            present.has(part.partNumber) || part.byteCount !== Math.min(registration.partBytes,
              file.size - (part.partNumber - 1) * registration.partBytes)) throw new Error("The stored upload parts are invalid.");
        present.add(part.partNumber);
        confirmedBytes += part.byteCount;
      }
      if (confirmedBytes) input.onProgress?.(confirmedBytes, file.size);
      for (let offset = 0, partNumber = 1; offset < file.size; offset += registration.partBytes, partNumber++) {
        input.signal?.throwIfAborted();
        if (present.has(partNumber)) continue;
        const signed = await control<{ uploadUrl: string }>(registration.uploadId, { action: "sign", partNumber }, input.signal);
        const part = file.slice(offset, Math.min(file.size, offset + registration.partBytes));
        const response = await fetch(signed.uploadUrl, { method: "PUT", body: part, credentials: "omit", ...signalOption });
        // Storage returns an empty body on success. Only application control routes return JSON.
        if (!response.ok) throw new Error("A file part did not upload. Retry the upload.");
        confirmedBytes += part.size;
        input.onProgress?.(confirmedBytes, file.size);
      }
    } else {
      await json(await fetch(registration.uploadUrl, { method: "PUT", body: file, ...signalOption }), "The file did not upload.");
    }
    attempt.uploaded = true;
  }
  input.signal?.throwIfAborted();
  input.onProgress?.(file.size, file.size);
  input.onStage("finalizing");
  const completed = registration.transport === "multipart"
    ? await control<{ sourceVideoId: string }>(registration.uploadId, { action: "complete" }, input.signal)
    : await json<{ sourceVideoId: string }>(await fetch(`/api/uploads/${encodeURIComponent(registration.uploadId)}/complete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, ...signalOption,
      body: JSON.stringify({ filename: file.name, size: file.size, type: file.type }),
    }), "Could not finish the upload.");
  attempt.sourceVideoId = completed.sourceVideoId;
  return completed.sourceVideoId;
}


/** Call after the local upload promise settles. Keep the attempt until the server confirms cancellation. */
export async function cancelBrowserUpload(attempt: BrowserUploadAttempt): Promise<void> {
  if (attempt.registration.transport !== "multipart") throw new Error("This upload does not support cancellation.");
  if (attempt.sourceVideoId) throw new Error("This upload already completed.");
  const result = await control<{ state: string }>(attempt.registration.uploadId, { action: "abort" });
  if (result.state !== "ABORTED") throw new Error("The server did not confirm cancellation.");
}
