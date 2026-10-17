import { describe, expect, it, vi } from "vitest";
import { runPercExperiment, type PercExperimentDeps, type PercExperimentSettings } from "@/lib/perc/experiment";
import { StreamApiError, StreamClient, type FetchLike } from "@/lib/perc/stream-client";

const ACCOUNT = "a".repeat(32);
const TOKEN = "token-value-that-must-never-appear";
const KEY = "stream-key-that-must-never-appear";
const URL_SECRET = "https://customer-x.cloudflarestream.com/v1/downloads/default.mp4";

const settings: PercExperimentSettings = {
  runId: "run-1", pushSeconds: 60, deleteRecordingAfterDays: 30, recordingTimeoutMs: 60_000, downloadTimeoutMs: 60_000,
  deletionTimeoutMs: 60_000, pollIntervalMs: 10_000, maxDownloadBytes: 1_000_000, durationToleranceS: 3,
  prices: { storedPer1000MinutesUsd: 5, deliveredPer1000MinutesUsd: 1, evidenceUrl: "https://example.test/pricing", checkedOn: "2026-10-16" },
};

function harness(options: { downloadPolls?: number; neverReady?: boolean; videoNeverAbsent?: boolean;
  durationS?: number; pushFails?: boolean } = {}) {
  let clock = 0;
  let downloadReads = 0;
  const deleted = new Set<string>();
  const calls: string[] = [];
  const client: PercExperimentDeps["client"] = {
    verifyToken: vi.fn(async () => ({ status: "active" })),
    createLiveInput: vi.fn(async () => { calls.push("createLiveInput");
      return { uid: "live-1", rtmps: { url: "rtmps://live.example.test:443/live/", streamKey: KEY }, recording: { mode: "automatic" } }; }),
    listLiveInputVideos: vi.fn(async () => clock < 20_000 ? [{ uid: "video-1", status: { state: "live-inprogress" } }]
      : [{ uid: "video-1", status: { state: "ready" }, readyToStream: true, duration: 60 }]),
    getVideo: vi.fn(),
    createDownload: vi.fn(async () => { calls.push("createDownload"); return { default: { status: "inprogress", percentComplete: 0 } }; }),
    getDownloads: vi.fn(async () => {
      downloadReads++;
      if (options.neverReady || downloadReads <= (options.downloadPolls ?? 2)) return { default: { status: "inprogress", percentComplete: downloadReads * 30 } };
      return { default: { status: "ready", percentComplete: 100, url: URL_SECRET } };
    }),
    deleteVideo: vi.fn(async (id: string) => { calls.push("deleteVideo"); deleted.add(id); }),
    deleteLiveInput: vi.fn(async (id: string) => { calls.push("deleteLiveInput"); deleted.add(id); }),
    isAbsent: vi.fn(async (kind: string, id: string) => kind === "video" && options.videoNeverAbsent ? false : deleted.has(id)),
  };
  const deps: PercExperimentDeps = {
    client,
    pushSyntheticStream: vi.fn(async () => { if (options.pushFails) throw new Error("PERC_PUSH_FAILED_1"); clock += 60_000; }),
    downloadFile: vi.fn(async () => ({ path: "/tmp/recording.mp4", byteCount: 1234, sha256: "f".repeat(64) })),
    probe: vi.fn(async () => ({ durationS: options.durationS ?? 60.2, width: 1280, height: 720, hasAudio: true })),
    urlStatus: vi.fn(async () => deleted.has("video-1") ? 404 : 200),
    removeLocal: vi.fn(async () => {}),
    sleep: vi.fn(async (ms: number) => { clock += ms; }),
    now: () => clock,
  };
  return { deps, client, calls };
}

describe("runPercExperiment", () => {
  it("proves retrieval and deletion and keeps secrets out of the report", async () => {
    const { deps, calls } = harness();
    const report = await runPercExperiment(deps, settings);
    expect(report.conclusion).toBe("RETRIEVAL_AND_DELETION_PROVEN");
    expect(report.residualResources).toEqual([]);
    expect(report.retrieval).toMatchObject({ byteCount: 1234, durationS: 60.2, width: 1280, hasAudio: true });
    expect(report.deletion).toMatchObject({ videoAbsent: { confirmed: true }, downloadsAbsent: { confirmed: true },
      downloadUrlUnavailable: { confirmed: true }, liveInputAbsent: { confirmed: true } });
    expect(calls.indexOf("createDownload")).toBeLessThan(calls.indexOf("deleteVideo"));
    const text = JSON.stringify(report);
    for (const secret of [KEY, TOKEN, URL_SECRET]) expect(text).not.toContain(secret);
    expect(report.steps.find(step => step.step === "wait_for_mp4_download")?.detail).toMatchObject({ percentComplete: [30, 60, 100] });
    expect(report.productionApproved).toBe(false);
  });

  it("creates the MP4 download explicitly instead of waiting for a status that never appears", async () => {
    const { deps, client } = harness();
    await runPercExperiment(deps, settings);
    expect(client.createDownload).toHaveBeenCalledWith("video-1");
  });

  it("fails on a download timeout but still deletes every created resource", async () => {
    const { deps, client } = harness({ neverReady: true });
    const report = await runPercExperiment(deps, settings);
    expect(report.conclusion).toBe("FAILED");
    expect(report.steps.find(step => step.step === "wait_for_mp4_download")).toMatchObject({ outcome: "FAILED",
      detail: { error: "PERC_POLL_TIMEOUT" } });
    expect(report.steps.find(step => step.step === "download_and_verify_mp4")?.outcome).toBe("SKIPPED");
    expect(client.deleteVideo).toHaveBeenCalledWith("video-1");
    expect(client.deleteLiveInput).toHaveBeenCalledWith("live-1");
    expect(report.residualResources).toEqual([]);
  });

  it("reports unconfirmed deletion as residual and not proven", async () => {
    const { deps } = harness({ videoNeverAbsent: true });
    const report = await runPercExperiment(deps, settings);
    expect(report.conclusion).toBe("FAILED");
    expect(report.residualResources).toContain("video:video-1");
    expect(report.deletion).toMatchObject({ videoAbsent: { confirmed: false, error: "PERC_POLL_TIMEOUT" } });
  });

  it("rejects an MP4 whose duration does not match the recording", async () => {
    const { deps, client } = harness({ durationS: 40 });
    const report = await runPercExperiment(deps, settings);
    expect(report.steps.find(step => step.step === "download_and_verify_mp4")).toMatchObject({ outcome: "FAILED",
      detail: { error: "PERC_MP4_DURATION_MISMATCH" } });
    expect(deps.removeLocal).toHaveBeenCalledWith("/tmp/recording.mp4");
    expect(client.deleteVideo).toHaveBeenCalled();
    expect(report.retrieval).toBeNull();
  });

  it("deletes the live input when the push fails before any recording exists", async () => {
    const { deps, client } = harness({ pushFails: true });
    const report = await runPercExperiment(deps, settings);
    expect(report.conclusion).toBe("FAILED");
    expect(client.listLiveInputVideos).not.toHaveBeenCalled();
    expect(client.deleteVideo).not.toHaveBeenCalled();
    expect(client.deleteLiveInput).toHaveBeenCalledWith("live-1");
    expect(report.residualResources).toEqual([]);
  });
});

describe("StreamClient", () => {
  function fetchReturning(status: number, body: unknown) {
    return vi.fn<FetchLike>(async () => ({ status, json: async () => body }));
  }

  it("rejects malformed account identifiers and tokens before any request", () => {
    expect(() => new StreamClient({ accountId: "pulpit", apiToken: TOKEN, fetch: fetchReturning(200, {}) })).toThrow("ACCOUNT_ID_INVALID");
    expect(() => new StreamClient({ accountId: ACCOUNT, apiToken: "short", fetch: fetchReturning(200, {}) })).toThrow("TOKEN_INVALID");
  });

  it("sends bearer authentication and the documented live input body", async () => {
    const fetch = fetchReturning(200, { success: true, errors: [], result: { uid: "live-1",
      rtmps: { url: "rtmps://live.example.test/live/", streamKey: KEY }, recording: { mode: "automatic" } } });
    await new StreamClient({ accountId: ACCOUNT, apiToken: TOKEN, fetch }).createLiveInput({ name: "n", deleteRecordingAfterDays: 30 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/stream/live_inputs`);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body!)).toEqual({ meta: { name: "n" }, recording: { mode: "automatic" },
      requireSignedURLs: false, deleteRecordingAfterDays: 30 });
  });

  it("keeps provider messages, tokens, and identifiers out of errors", async () => {
    const fetch = fetchReturning(403, { success: false, errors: [{ code: 10000, message: `bad ${TOKEN}` }] });
    const error = await new StreamClient({ accountId: ACCOUNT, apiToken: TOKEN, fetch }).deleteVideo("b".repeat(32)).catch(e => e);
    expect(error).toBeInstanceOf(StreamApiError);
    expect(error).toMatchObject({ status: 403, codes: [10000] });
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(ACCOUNT);
  });

  it("accepts a successful DELETE without a JSON envelope but not other bodyless responses", async () => {
    const bodyless = vi.fn<FetchLike>(async () => ({ status: 200, json: async () => { throw new SyntaxError("empty"); } }));
    const client = new StreamClient({ accountId: ACCOUNT, apiToken: TOKEN, fetch: bodyless });
    await expect(client.deleteVideo("v")).resolves.toBeUndefined();
    await expect(client.getVideo("v")).rejects.toBeInstanceOf(StreamApiError);
  });

  it("treats only HTTP 404 as absent", async () => {
    const absent = new StreamClient({ accountId: ACCOUNT, apiToken: TOKEN,
      fetch: fetchReturning(404, { success: false, errors: [{ code: 10003, message: "not found" }] }) });
    expect(await absent.isAbsent("video", "v")).toBe(true);
    const denied = new StreamClient({ accountId: ACCOUNT, apiToken: TOKEN,
      fetch: fetchReturning(403, { success: false, errors: [{ code: 10000, message: "denied" }] }) });
    await expect(denied.isAbsent("video", "v")).rejects.toBeInstanceOf(StreamApiError);
  });
});
