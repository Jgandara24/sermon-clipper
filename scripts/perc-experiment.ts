#!/usr/bin/env tsx
/**
 * Isolated PERC retrieval and deletion experiment (P4 item 20).
 *
 * Plan mode (default) prints the steps and contacts nothing.
 * Execution needs all of: --execute, --confirm-account-owner sermon-clipper, a new --output directory,
 * and PERC_CF_ACCOUNT_ID plus PERC_CF_API_TOKEN for a Sermon Clipper-owned Cloudflare account.
 * The token needs only Stream Read and Stream Write. Never use Pulpit Engine's account (DECISIONS.md 2026-07-23).
 * The feed is synthetic ffmpeg test video. No church media is used.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeVideoFile } from "../src/lib/media/probe";
import { runPercExperiment, type PercExperimentSettings } from "../src/lib/perc/experiment";
import { StreamClient, type FetchLike } from "../src/lib/perc/stream-client";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

const settings: PercExperimentSettings = {
  runId: randomUUID(), pushSeconds: Number(value("--push-seconds") ?? 90), deleteRecordingAfterDays: 30,
  recordingTimeoutMs: 10 * 60_000, downloadTimeoutMs: 30 * 60_000, deletionTimeoutMs: 10 * 60_000, pollIntervalMs: 15_000,
  maxDownloadBytes: 512 * 1024 * 1024, durationToleranceS: 3,
  prices: { storedPer1000MinutesUsd: 5, deliveredPer1000MinutesUsd: 1,
    evidenceUrl: "https://developers.cloudflare.com/stream/pricing/", checkedOn: "2026-10-16" },
};

const PLAN = [
  "1. Verify the API token (GET /user/tokens/verify).",
  "2. Create one live input with automatic recording and deleteRecordingAfterDays=30 as a safety net.",
  `3. Push ${settings.pushSeconds} s of synthetic 1280x720 test video with a 440 Hz tone over RTMPS.`,
  "4. Poll the live input's videos until exactly one recording is ready.",
  "5. Create the default MP4 download explicitly, then poll until it is ready.",
  "6. Download the MP4 with a byte limit; verify checksum, duration, dimensions, and audio.",
  "7. Delete the local copy, the recording, and the live input; poll until each reports absent.",
  "8. Check that the former MP4 URL no longer serves the file.",
  "9. Write report.json with no token, stream key, or download URL.",
];

function realFetch(): FetchLike {
  return async (url, init) => { const response = await fetch(url, init); return { status: response.status, json: () => response.json() }; };
}

function pushSyntheticStream(target: { url: string; streamKey: string }, seconds: number) {
  return new Promise<void>((resolve, reject) => {
    // The stream key is visible to local process listings while ffmpeg runs. It is never logged or reported.
    const child = spawn("ffmpeg", ["-nostdin", "-v", "verbose", "-re", "-f", "lavfi", "-i", `testsrc2=s=1280x720:r=30:d=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`, "-c:v", "libx264", "-preset", "veryfast",
      "-g", "60", "-b:v", "2500k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-f", "flv",
      `${target.url.replace(/\/$/, "")}/${target.streamKey}`], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    // Verbose output shows the RTMP handshake and any server status. Keep the start and the end.
    let head = "";
    child.stderr.on("data", chunk => { if (head.length < 3000) head += chunk; stderr = (stderr + chunk).slice(-3000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`PERC_PUSH_FAILED_${code}: ${(head.slice(0, 3000) + "\n...\n" + stderr).split(target.streamKey).join("[key]")}`)));
  });
}

async function downloadFile(directory: string, url: string, maxBytes: number) {
  const response = await fetch(url);
  if (response.status !== 200 || !response.body) throw new Error(`PERC_DOWNLOAD_HTTP_${response.status}`);
  const file = path.join(directory, "recording.mp4");
  const hash = createHash("sha256");
  const out = createWriteStream(file, { flags: "wx" });
  let byteCount = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    byteCount += chunk.byteLength;
    if (byteCount > maxBytes) { out.destroy(); throw new Error("PERC_DOWNLOAD_TOO_LARGE"); }
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise<void>(resolve => out.once("drain", () => resolve()));
  }
  await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()));
  return { path: file, byteCount, sha256: hash.digest("hex") };
}

async function main() {
  if (!flag("--execute")) {
    console.log(["PERC experiment plan (nothing contacted):", ...PLAN,
      "Run with: --execute --confirm-account-owner sermon-clipper --output <new-directory>",
      "Requires PERC_CF_ACCOUNT_ID and PERC_CF_API_TOKEN (Stream Read and Stream Write only)."].join("\n"));
    return;
  }
  if (value("--confirm-account-owner") !== "sermon-clipper") throw new Error("Confirm a Sermon Clipper-owned Cloudflare account.");
  const output = value("--output");
  if (!output || existsSync(output)) throw new Error("A new --output directory is required.");
  const accountId = process.env.PERC_CF_ACCOUNT_ID ?? "";
  const apiToken = process.env.PERC_CF_API_TOKEN ?? "";
  if (!Number.isInteger(settings.pushSeconds) || settings.pushSeconds < 30 || settings.pushSeconds > 600) {
    throw new Error("--push-seconds must be an integer from 30 to 600.");
  }
  // Validates credentials before anything is created locally or remotely.
  const client = new StreamClient({ accountId, apiToken, fetch: realFetch() });
  await mkdir(output, { recursive: false });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "perc-experiment-"));
  try {
    const report = await runPercExperiment({
      client, pushSyntheticStream, downloadFile: (url, max) => downloadFile(scratch, url, max),
      probe: async file => { const probe = await probeVideoFile(file); return { durationS: probe.durationS,
        width: probe.width, height: probe.height, hasAudio: probe.hasAudio }; },
      urlStatus: async url => (await fetch(url, { method: "HEAD" })).status,
      removeLocal: file => rm(file, { force: true }),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: () => Date.now(),
    }, settings);
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ report: path.join(output, "report.json"), conclusion: report.conclusion,
      residualResources: report.residualResources }));
    if (report.conclusion !== "RETRIEVAL_AND_DELETION_PROVEN") process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
