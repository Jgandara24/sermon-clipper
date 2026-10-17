import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cancelBrowserUpload, uploadBrowserVideo, type BrowserUploadAttempt } from "@/lib/uploads/browser-upload";
const fetchMock = vi.fn<typeof fetch>();
const file = new File(["abcdefgh"], "service.mp4", { type: "video/mp4" });
const registration = { uploadId: "fixture", transport: "multipart" as const, partBytes: 3, totalBytes: 8 };
function data(value: unknown) { return Response.json({ data: value }); }
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

it("sends exact Blob parts directly to storage and completes through the session", async () => {
  const bodies: string[] = [];
  let number = 0;
  fetchMock.mockImplementation(async (url, init) => {
    if (url === "/api/uploads/presign") return data(registration);
    if (String(url).startsWith("https://storage.example.test/")) {
      expect(init?.credentials).toBe("omit");
      bodies.push(await (init?.body as Blob).text());
      return new Response(null, { status: 200 });
    }
    const body = JSON.parse(String(init?.body));
    if (body.action === "start") return data({ state: "UPLOADING" });
    if (body.action === "list") return data({ parts: [] });
    if (body.action === "sign") {
      expect(body.partNumber).toBe(++number);
      return data({ uploadUrl: `https://storage.example.test/${number}` });
    }
    expect(body).toEqual({ action: "complete" });
    expect(bodies).toEqual(["abc", "def", "gh"]);
    return data({ sourceVideoId: "source" });
  });
  const onAttempt = vi.fn();
  expect(await uploadBrowserVideo(file, { attempt: null, onAttempt, onStage: vi.fn() })).toBe("source");
  expect(onAttempt).toHaveBeenCalledTimes(1);
  expect(onAttempt.mock.calls[0][0]).toMatchObject({ uploaded: true, sourceVideoId: "source" });
});
it("reuses the upload ID after a lost completion response without repeating file bytes", async () => {
  const attempt: BrowserUploadAttempt = { registration, uploaded: true };
  fetchMock.mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce(data({ sourceVideoId: "same-source" }));
  const input = { attempt, onAttempt: vi.fn(), onStage: vi.fn() };
  await expect(uploadBrowserVideo(file, input)).rejects.toThrow("lost response");
  expect(await uploadBrowserVideo(file, input)).toBe("same-source");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).toBe("/api/uploads/fixture/multipart");
    expect(JSON.parse(String(init?.body))).toEqual({ action: "complete" });
  }
  expect(await uploadBrowserVideo(file, input)).toBe("same-source");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("retains registration after a part failure and never completes partial bytes", async () => {
  fetchMock.mockResolvedValueOnce(data(registration)).mockResolvedValueOnce(data({ state: "UPLOADING" })).mockResolvedValueOnce(data({ parts: [] }))
    .mockResolvedValueOnce(data({ uploadUrl: "https://storage.example.test/1" }))
    .mockResolvedValueOnce(new Response(null, { status: 500 }));
  const onAttempt = vi.fn();
  await expect(uploadBrowserVideo(file, { attempt: null, onAttempt, onStage: vi.fn() })).rejects.toThrow("file part");
  expect(onAttempt.mock.calls[0][0]).toMatchObject({ registration, uploaded: false });
  expect(fetchMock).toHaveBeenCalledTimes(5);
});
it("preserves the local relay flow", async () => {
  fetchMock.mockResolvedValueOnce(data({ uploadId: "local", transport: "relay", uploadUrl: "/signed-relay" }))
    .mockResolvedValueOnce(data({ bytesWritten: 8 })).mockResolvedValueOnce(data({ sourceVideoId: "source" }));
  expect(await uploadBrowserVideo(file, { attempt: null, onAttempt: vi.fn(), onStage: vi.fn() })).toBe("source");
  expect(fetchMock.mock.calls[1]).toEqual(["/signed-relay", { method: "PUT", body: file }]);
  expect(fetchMock.mock.calls[2][0]).toBe("/api/uploads/local/complete");
});
it.each([0, NaN, -1, 1.5])("refuses an invalid part size %s", async partBytes => {
  const attempt = { registration: { ...registration, partBytes }, uploaded: false };
  await expect(uploadBrowserVideo(file, { attempt, onAttempt: vi.fn(), onStage: vi.fn() })).rejects.toThrow("size");
  expect(fetchMock).not.toHaveBeenCalled();
});


it("reports confirmed part progress and stops before another part after cancellation", async () => {
  const controller = new AbortController();
  const progress: number[] = [];
  fetchMock.mockResolvedValueOnce(data(registration)).mockResolvedValueOnce(data({ state: "UPLOADING" })).mockResolvedValueOnce(data({ parts: [] }))
    .mockResolvedValueOnce(data({ uploadUrl: "https://storage.example.test/1" }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  const onAttempt = vi.fn();
  await expect(uploadBrowserVideo(file, { attempt: null, onAttempt, onStage: vi.fn(), signal: controller.signal,
    onProgress: uploaded => { progress.push(uploaded); if (uploaded === 3) controller.abort(); },
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(progress).toEqual([0, 3]);
  expect(fetchMock).toHaveBeenCalledTimes(5);
  for (const [, init] of fetchMock.mock.calls) expect(init?.signal).toBe(controller.signal);
  expect(onAttempt.mock.calls[0][0]).toMatchObject({ uploaded: false });
});
it("does not start network work with an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(uploadBrowserVideo(file, { attempt: null, onAttempt: vi.fn(), onStage: vi.fn(), signal: controller.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(fetchMock).not.toHaveBeenCalled();
});
it("confirms cancellation through the same session without an aborted fetch signal", async () => {
  const attempt = { registration, uploaded: false };
  fetchMock.mockResolvedValueOnce(data({ state: "ABORTED" }));
  await cancelBrowserUpload(attempt);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("/api/uploads/fixture/multipart");
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ action: "abort" });
  expect(fetchMock.mock.calls[0][1]?.signal).toBeUndefined();
});
it.each(["pending", "failure"])("retains the attempt after unconfirmed cancellation (%s)", async mode => {
  const attempt = { registration, uploaded: false };
  const original = structuredClone(attempt);
  fetchMock.mockResolvedValueOnce(mode === "pending" ? data({ state: "ABORTING" })
    : Response.json({ error: { message: "Cancellation needs review." } }, { status: 409 }));
  await expect(cancelBrowserUpload(attempt)).rejects.toThrow();
  expect(attempt).toEqual(original);
});
it("refuses browser cancellation after confirmed completion", async () => {
  await expect(cancelBrowserUpload({ registration, uploaded: true, sourceVideoId: "source" })).rejects.toThrow("already completed");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("resumes missing parts after storage accepts a part but its response is lost", async () => {
  const stored = new Map<number, string>();
  const puts: number[] = [];
  let loseResponse = true;
  fetchMock.mockImplementation(async (url, init) => {
    if (url === "/api/uploads/presign") return data(registration);
    if (String(url).startsWith("https://storage.example.test/")) {
      const number = Number(String(url).split("/").pop());
      puts.push(number);
      stored.set(number, await (init?.body as Blob).text());
      if (loseResponse) { loseResponse = false; throw new Error("lost part response"); }
      return new Response(null, { status: 200 });
    }
    const body = JSON.parse(String(init?.body));
    if (body.action === "start") return data({ state: "UPLOADING" });
    if (body.action === "list") return data({ parts: [...stored].map(([partNumber, bytes]) => ({ partNumber, byteCount: bytes.length })) });
    if (body.action === "sign") return data({ uploadUrl: `https://storage.example.test/${body.partNumber}` });
    expect(body.action).toBe("complete");
    expect([...stored.values()].join("")).toBe("abcdefgh");
    return data({ sourceVideoId: "resumed-source" });
  });
  const onAttempt = vi.fn<(attempt: BrowserUploadAttempt) => void>();
  await expect(uploadBrowserVideo(file, { attempt: null, onAttempt, onStage: vi.fn() })).rejects.toThrow("lost part response");
  const progress: number[] = [];
  expect(await uploadBrowserVideo(file, { attempt: onAttempt.mock.calls[0][0], onAttempt, onStage: vi.fn(),
    onProgress: bytes => progress.push(bytes) })).toBe("resumed-source");
  expect(puts).toEqual([1, 2, 3]);
  expect(progress).toEqual([0, 3, 6, 8, 8]);
  expect(onAttempt).toHaveBeenCalledTimes(1);
});
it.each([
  [{ partNumber: 0, byteCount: 3 }], [{ partNumber: 4, byteCount: 3 }],
  [{ partNumber: 1, byteCount: 2 }], [{ partNumber: 3, byteCount: 3 }],
  [{ partNumber: 1, byteCount: 3 }, { partNumber: 1, byteCount: 3 }],
].map(parts => ({ parts })))("refuses an invalid stored-part list %#", async stored => {
  fetchMock.mockResolvedValueOnce(data({ state: "UPLOADING" })).mockResolvedValueOnce(data(stored));
  await expect(uploadBrowserVideo(file, { attempt: { registration, uploaded: false }, onAttempt: vi.fn(), onStage: vi.fn() }))
    .rejects.toThrow("stored upload parts");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
