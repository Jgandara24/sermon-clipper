import type { StreamClient, StreamDownloads } from "./stream-client";

export const PERC_EXPERIMENT_VERSION = "perc-retrieval-deletion-experiment-v1";

export type PercExperimentSettings = {
  runId: string; pushSeconds: number; deleteRecordingAfterDays: number;
  recordingTimeoutMs: number; downloadTimeoutMs: number; deletionTimeoutMs: number; pollIntervalMs: number;
  maxDownloadBytes: number; durationToleranceS: number;
  /** Dated published prices, used only for the report's estimate. */
  prices: { storedPer1000MinutesUsd: number; deliveredPer1000MinutesUsd: number; evidenceUrl: string; checkedOn: string };
};

export type PercExperimentDeps = {
  client: Pick<StreamClient, "verifyToken" | "createLiveInput" | "listLiveInputVideos" | "getVideo" | "createDownload" |
    "getDownloads" | "deleteVideo" | "deleteLiveInput" | "isAbsent">;
  /** Pushes a synthetic RTMPS feed. The key must stay out of logs and reports. */
  pushSyntheticStream(target: { url: string; streamKey: string }, seconds: number): Promise<void>;
  /** Downloads with a byte limit and returns local file facts. */
  downloadFile(url: string, maxBytes: number): Promise<{ path: string; byteCount: number; sha256: string }>;
  probe(path: string): Promise<{ durationS: number; width: number | null; height: number | null; hasAudio: boolean }>;
  /** Unauthenticated status of a former public download URL. */
  urlStatus(url: string): Promise<number>;
  removeLocal(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

type Step = { step: string; outcome: "PASSED" | "FAILED" | "SKIPPED"; elapsedMs: number; detail?: Record<string, unknown> };

export type PercExperimentReport = {
  version: typeof PERC_EXPERIMENT_VERSION; runId: string; scope: "SYNTHETIC_RTMPS_FEED_ONLY";
  steps: Step[]; retrieval: Record<string, unknown> | null; deletion: Record<string, unknown>;
  costEstimate: Record<string, unknown> | null; residualResources: string[];
  conclusion: "RETRIEVAL_AND_DELETION_PROVEN" | "FAILED"; productionApproved: false;
};

async function pollUntil<T>(deps: PercExperimentDeps, timeoutMs: number, intervalMs: number,
  read: () => Promise<T>, done: (value: T) => boolean): Promise<{ value: T; observations: number }> {
  const deadline = deps.now() + timeoutMs;
  let observations = 0;
  for (;;) {
    const value = await read();
    observations++;
    if (done(value)) return { value, observations };
    if (deps.now() >= deadline) throw new Error("PERC_POLL_TIMEOUT");
    await deps.sleep(intervalMs);
  }
}

/**
 * Proves, on a synthetic feed, that a recording can be retrieved as a verified MP4 and then deleted.
 * Created resources are deleted in every outcome; anything unconfirmed is listed as residual.
 */
export async function runPercExperiment(deps: PercExperimentDeps, settings: PercExperimentSettings): Promise<PercExperimentReport> {
  const steps: Step[] = [];
  const created: { liveInputId?: string; videoId?: string; downloadUrl?: string; localPath?: string } = {};
  let retrieval: PercExperimentReport["retrieval"] = null;
  let failed = false;
  const step = async <T>(name: string, work: () => Promise<{ value: T; detail?: Record<string, unknown> }>): Promise<T | undefined> => {
    if (failed) { steps.push({ step: name, outcome: "SKIPPED", elapsedMs: 0 }); return undefined; }
    const started = deps.now();
    try {
      const { value, detail } = await work();
      steps.push({ step: name, outcome: "PASSED", elapsedMs: deps.now() - started, ...(detail ? { detail } : {}) });
      return value;
    } catch (error) {
      failed = true;
      steps.push({ step: name, outcome: "FAILED", elapsedMs: deps.now() - started,
        detail: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  };

  await step("verify_token", async () => ({ value: null, detail: { status: (await deps.client.verifyToken()).status } }));
  const input = await step("create_live_input", async () => {
    const live = await deps.client.createLiveInput({ name: `sermon-clipper-perc-experiment-${settings.runId}`,
      deleteRecordingAfterDays: settings.deleteRecordingAfterDays });
    created.liveInputId = live.uid;
    return { value: live, detail: { liveInputId: live.uid, recordingMode: live.recording.mode } };
  });
  await step("push_synthetic_feed", async () => {
    await deps.pushSyntheticStream({ url: input!.rtmps.url, streamKey: input!.rtmps.streamKey }, settings.pushSeconds);
    return { value: null, detail: { pushSeconds: settings.pushSeconds } };
  });
  const recordingStarted = deps.now();
  const video = await step("wait_for_recording", async () => {
    const { value, observations } = await pollUntil(deps, settings.recordingTimeoutMs, settings.pollIntervalMs,
      () => deps.client.listLiveInputVideos(created.liveInputId!),
      videos => videos.some(item => item.status.state === "ready" && item.readyToStream !== false));
    const ready = value.filter(item => item.status.state === "ready");
    if (ready.length !== 1) throw new Error(`PERC_EXPECTED_ONE_RECORDING_GOT_${ready.length}`);
    created.videoId = ready[0].uid;
    return { value: ready[0], detail: { videoId: ready[0].uid, observations, recordingCount: value.length,
      reportedDurationS: ready[0].duration ?? null, readyAfterPushMs: deps.now() - recordingStarted } };
  });
  // Pulpit Engine saw download_status = null because no download had been created. Create it explicitly.
  await step("create_mp4_download", async () => {
    const result = await deps.client.createDownload(created.videoId!);
    return { value: result, detail: { initialStatus: result.default?.status ?? null } };
  });
  const ready = await step("wait_for_mp4_download", async () => {
    const progress: Array<number | null> = [];
    const { value, observations } = await pollUntil<StreamDownloads>(deps, settings.downloadTimeoutMs, settings.pollIntervalMs,
      async () => { const current = await deps.client.getDownloads(created.videoId!); progress.push(current.default?.percentComplete ?? null); return current; },
      current => current.default?.status === "ready" && !!current.default.url);
    created.downloadUrl = value.default!.url!;
    return { value, detail: { observations, percentComplete: progress } };
  });
  await step("download_and_verify_mp4", async () => {
    const file = await deps.downloadFile(ready!.default!.url!, settings.maxDownloadBytes);
    created.localPath = file.path;
    const probe = await deps.probe(file.path);
    const expected = video!.duration ?? settings.pushSeconds;
    if (!probe.hasAudio || probe.width === null || probe.height === null) throw new Error("PERC_MP4_STREAMS_MISSING");
    if (Math.abs(probe.durationS - expected) > settings.durationToleranceS) throw new Error("PERC_MP4_DURATION_MISMATCH");
    retrieval = { byteCount: file.byteCount, sha256: file.sha256, durationS: probe.durationS, width: probe.width,
      height: probe.height, hasAudio: probe.hasAudio, providerDurationS: video!.duration ?? null, pushSeconds: settings.pushSeconds };
    return { value: null, detail: { byteCount: file.byteCount, durationS: probe.durationS } };
  });

  // Deletion runs regardless of earlier failures, for every resource that was created.
  const deletion: Record<string, unknown> = {};
  const residual: string[] = [];
  const confirmGone = async (label: string, check: () => Promise<boolean>) => {
    const started = deps.now();
    try {
      const { observations } = await pollUntil(deps, settings.deletionTimeoutMs, settings.pollIntervalMs, check, gone => gone);
      deletion[label] = { confirmed: true, observations, elapsedMs: deps.now() - started };
      return true;
    } catch (error) {
      deletion[label] = { confirmed: false, error: error instanceof Error ? error.message : String(error) };
      return false;
    }
  };
  if (created.localPath) await deps.removeLocal(created.localPath).catch(() => residual.push(`local:${created.localPath}`));
  if (created.videoId) {
    const id = created.videoId;
    try { await deps.client.deleteVideo(id); deletion.videoDeleteRequest = "ACCEPTED"; } catch (error) {
      deletion.videoDeleteRequest = error instanceof Error ? error.message : String(error);
    }
    if (!(await confirmGone("videoAbsent", () => deps.client.isAbsent("video", id)))) residual.push(`video:${id}`);
    if (!(await confirmGone("downloadsAbsent", () => deps.client.isAbsent("downloads", id)))) residual.push(`downloads:${id}`);
    const url = created.downloadUrl;
    if (url && !(await confirmGone("downloadUrlUnavailable", async () => (await deps.urlStatus(url)) >= 400))) residual.push("download-url");
  }
  if (created.liveInputId) {
    const id = created.liveInputId;
    try { await deps.client.deleteLiveInput(id); deletion.liveInputDeleteRequest = "ACCEPTED"; } catch (error) {
      deletion.liveInputDeleteRequest = error instanceof Error ? error.message : String(error);
    }
    if (!(await confirmGone("liveInputAbsent", () => deps.client.isAbsent("liveInput", id)))) residual.push(`liveInput:${id}`);
  }
  steps.push({ step: "delete_and_confirm", outcome: residual.length === 0 && (created.videoId || created.liveInputId) ? "PASSED" : "FAILED",
    elapsedMs: 0, detail: { residual } });

  const minutes = settings.pushSeconds / 60;
  const costEstimate = retrieval ? { storedMinutes: minutes, deliveredMinutes: minutes,
    // Storage bills monthly capacity; a recording held for one day costs about 1/30 of a month.
    storageMonthUsdIfHeldAllMonth: (minutes / 1000) * settings.prices.storedPer1000MinutesUsd,
    mp4DeliveryUsd: (minutes / 1000) * settings.prices.deliveredPer1000MinutesUsd,
    priceEvidenceUrl: settings.prices.evidenceUrl, pricesCheckedOn: settings.prices.checkedOn,
    status: "ESTIMATE_NOT_INVOICE" } : null;
  const proven = !failed && residual.length === 0 && retrieval !== null;
  return { version: PERC_EXPERIMENT_VERSION, runId: settings.runId, scope: "SYNTHETIC_RTMPS_FEED_ONLY", steps, retrieval,
    deletion, costEstimate, residualResources: residual, conclusion: proven ? "RETRIEVAL_AND_DELETION_PROVEN" : "FAILED",
    productionApproved: false };
}
