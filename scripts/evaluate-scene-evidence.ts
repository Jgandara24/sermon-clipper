import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAnalysisDerivatives, type AnalysisDerivativeSettings } from "../src/lib/media/analysis-derivatives";
import { extractVideoEvidence, type VideoEvidenceSettings } from "../src/lib/media/video-evidence";
import { evaluateSceneChanges } from "../src/lib/media-regions/scene-change-evaluation";
import { fileIdentity } from "../src/lib/storage/file-identity";

// The existing local test configuration. These values are not production thresholds.
const derivativeSettings: AnalysisDerivativeSettings = { proxyCrf: 18, proxyPreset: "ultrafast", proxyAudioBitrateBps: 64000,
  flacCompressionLevel: 5, encoderThreads: 4, timeoutMs: 2 * 60 * 60 * 1000 };
const videoSettings: VideoEvidenceSettings = { sceneThreshold: 5, blackPixelThreshold: 0.1, blackPictureRatio: 0.98,
  blackMinimumMs: 200, freezeNoiseRatio: 0.001, freezeMinimumMs: 200, threads: 4,
  timeoutMs: 2 * 60 * 60 * 1000, maxMetadataBytes: 1024 * 1024 * 1024 };
const thresholds = [1, 2, 3, 5, 8, 10, 15, 20, 30, 50];

type Interval = { startUs: number; endUs: number };
type Label = { id: string; recording: string; category: string; kind: string; status: string; timeUs?: number;
  interval?: Interval; intervals?: Interval[]; frameEdgesUs?: { firstFrameOfView: number; firstFrameAfterView: number };
  detectorCandidateUs?: number; timeProvenance: string; problemInterval?: Interval; assistantTrackingContextUs?: Record<string, number> };
type LabelSet = { schemaVersion: string; recordings: { id: string; sourceSha256: string }[]; labels: Label[] };

// Labels also carry their interval convention. The scorer accepts only the two times.
const span = (interval: Interval) => ({ startUs: interval.startUs, endUs: interval.endUs });

/** Scored groups keep label provenance apart, so circular or gradual labels cannot inflate the exact-cut result. */
function sceneEvents(labels: Label[]) {
  const events: { id: string; group: string; timeUs?: number; windowUs?: Interval }[] = [];
  for (const label of labels) {
    if (label.id === "R1-V2-FULL-STAGE-SHOT") events.push({ id: label.id, group: "cut-time-supplied-by-jake", timeUs: label.timeUs });
    else if (label.category === "scene_change" && label.timeUs !== undefined) events.push({ id: label.id, group: "cut-frame-observed-by-assistant", timeUs: label.timeUs });
    else if (label.kind === "STAGE_AND_AUDIENCE_VIEW") {
      events.push({ id: `${label.id}:entry`, group: "view-edge-scene-assisted", timeUs: label.frameEdgesUs!.firstFrameOfView });
      events.push({ id: `${label.id}:exit`, group: "view-edge-scene-assisted", timeUs: label.frameEdgesUs!.firstFrameAfterView });
    } else if (label.kind === "PROMOTIONAL_OVERLAY") {
      events.push({ id: `${label.id}:entry`, group: "overlay-fade-edge", timeUs: label.frameEdgesUs!.firstFrameOfView });
      events.push({ id: `${label.id}:exit`, group: "overlay-fade-edge", timeUs: label.frameEdgesUs!.firstFrameAfterView });
    } else if (label.kind === "CAMERA_CHANGE_IN_WINDOW") {
      events.push({ id: label.id, group: "camera-change-window", windowUs: span(label.interval!) });
      events.push({ id: `${label.id}:earlier-candidate`, group: "earlier-detector-candidate-circular", timeUs: label.detectorCandidateUs });
    } else if (["human_exclusion", "proposed_exclusion"].includes(label.category) && label.interval && label.kind !== "DEFOCUSED_SPEAKER_VIEW") {
      // These edges have no stated visual cause. They are diagnostic and never count as misses.
      events.push({ id: `${label.id}:start`, group: "diagnostic-exclusion-edge", timeUs: label.interval.startUs });
      events.push({ id: `${label.id}:end`, group: "diagnostic-exclusion-edge", timeUs: label.interval.endUs });
    } else if (label.problemInterval) {
      events.push({ id: `${label.id}:problem-end`, group: "diagnostic-exclusion-edge", timeUs: label.problemInterval.endUs });
    } else if (label.assistantTrackingContextUs?.shotEnd !== undefined) {
      events.push({ id: `${label.id}:shot-end`, group: "diagnostic-tracking-context", timeUs: label.assistantTrackingContextUs.shotEnd });
    }
  }
  // Exclusion edges can coincide. Keep one event per id and time.
  return events.filter((event, index) => events.findIndex(other => other.id === event.id) === index);
}

function reviewedWindows(labels: Label[]) {
  return labels.filter(label => ["cameraCuts", "cameraCut", "CAMERA_CHANGE_IN_WINDOW"].includes(label.kind))
    .flatMap(label => (label.intervals ?? [label.interval!]).map((window, index) => ({ id: `${label.id}#${index}`, ...span(window) })));
}

async function main() {
  const [labelsPath, output, workRoot, ...sourceArgs] = process.argv.slice(2);
  if (!labelsPath || !output || !workRoot || !sourceArgs.length) {
    throw new Error("Usage: npx tsx scripts/evaluate-scene-evidence.ts LABELS.json OUTPUT.json WORK_DIR recording-id=/absolute/source.mp4 ...");
  }
  const labelBytes = await readFile(labelsPath);
  const labelSet = JSON.parse(labelBytes.toString("utf8")) as LabelSet;
  const results = [];
  for (const arg of sourceArgs) {
    const [recordingId, sourcePath] = [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)];
    const recording = labelSet.recordings.find(item => item.id === recordingId);
    if (!recording || !path.isAbsolute(sourcePath)) throw new Error(`Unknown recording or relative path: ${recordingId}`);
    const identity = await fileIdentity(sourcePath);
    if (identity.sha256 !== recording.sourceSha256) throw new Error(`Source checksum differs for ${recordingId}.`);
    const directory = await mkdtemp(path.join(workRoot, `${recordingId}-`));
    try {
      const started = performance.now();
      const derivatives = await buildAnalysisDerivatives({ sessionId: "offline-evaluation", sourceVideoId: `offline-${recordingId}`,
        sourcePath, directory, sha256: identity.sha256, byteCount: identity.byteCount, width: null, height: null,
        transcriptRevision: 0, download: undefined }, derivativeSettings);
      const derivativeWallMs = performance.now() - started;
      const evidenceStarted = performance.now();
      const video = await extractVideoEvidence({ path: derivatives.proxy.path, sha256: derivatives.proxy.sha256,
        byteCount: derivatives.proxy.byteCount, mapping: { sourceInterval: derivatives.sourceInterval, artifactOriginMs: 0, timeScale: "1:1" } },
      videoSettings);
      const evidenceWallMs = performance.now() - evidenceStarted;
      const frames = video.motion.map(frame => ({ timeMs: frame.timeMs, score: frame.sceneScore }));
      // The scorer derives detections from per-frame scores. Confirm that rule against scdet's own output.
      const derived = frames.filter(frame => frame.score >= videoSettings.sceneThreshold).map(frame => frame.timeMs);
      const reported = video.scenes.map(scene => scene.timeMs);
      const labels = labelSet.labels.filter(label => label.recording === recordingId);
      const events = sceneEvents(labels);
      const framePeriodMs = (frames.at(-1)!.timeMs - frames[0].timeMs) / (frames.length - 1);
      const evaluation = evaluateSceneChanges({ events, frames, thresholds,
        tolerancesMs: [Math.ceil(framePeriodMs) + 1, 250, 1000], reviewedWindowsUs: reviewedWindows(labels) });
      const neighborhoods = events.filter(event => event.timeUs !== undefined).map(event => ({ id: event.id,
        strongestFramesWithin1000Ms: frames.filter(frame => Math.abs(frame.timeMs - event.timeUs! / 1000) <= 1000)
          .sort((a, b) => b.score - a.score).slice(0, 3).map(frame => ({ timeMs: frame.timeMs, score: Math.round(frame.score * 1000) / 1000 })) }));
      results.push({ recording: recordingId, sourceSha256: identity.sha256, sourceByteCount: identity.byteCount,
        derivatives: { derivationVersion: derivatives.derivationVersion, configurationSha256: derivatives.configurationSha256,
          original: derivatives.original.video, proxy: { sha256: derivatives.proxy.sha256, byteCount: derivatives.proxy.byteCount,
            video: derivatives.proxy.facts.video }, wallMs: Math.round(derivativeWallMs) },
        evidence: { detectorVersion: video.detectorVersion, configurationSha256: video.configurationSha256,
          toolchainSha256: video.toolchainSha256, frameCount: video.frameCount, configuredThreshold: videoSettings.sceneThreshold,
          scenesAtConfiguredThreshold: reported.length, blackIntervals: video.black.length, freezeIntervals: video.freeze.length,
          derivedDetectionRuleMatchesScdet: JSON.stringify(derived) === JSON.stringify(reported), wallMs: Math.round(evidenceWallMs) },
        evaluation, neighborhoods });
    } finally {
      // Proxy and analysis audio are temporary derivatives of approved-local recordings.
      await rm(directory, { recursive: true, force: true });
    }
  }
  const report = { reportVersion: "p4-scene-evidence-report-v1", createdAt: new Date().toISOString(),
    labelSet: { file: path.basename(labelsPath), sha256: createHash("sha256").update(labelBytes).digest("hex"), schemaVersion: labelSet.schemaVersion },
    processing: "Local and offline. No network request, upload, or paid service.", derivativeSettings, videoSettings, thresholds, results };
  // Reports are evidence. Never overwrite an existing report implicitly.
  await writeFile(output, `${JSON.stringify(report, null, 1)}\n`, { flag: "wx" });
  console.log(`Wrote scene evidence report for ${results.length} recordings.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Scene evidence evaluation failed."); process.exitCode = 1; });
