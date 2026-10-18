/**
 * Phase 1 lab: render a side-by-side preview of one clip — today's fixed center crop | the
 * tracked crop — from face observations (scripts/lab/tracking/observe-faces.py).
 *
 *   node --import tsx scripts/lab/tracking/track-clip.ts --observations <json> --out <mp4> --label "Clip 1"
 *     [--rules codex|lab-v1]
 *
 * The path is Codex's tracker (src/lib/speaker-tracking), optionally behind the lab-v1 rules —
 * the same buildLabTrack the lab export uses. Nothing is hand-fixed. Frames where the tracker
 * stopped following are marked "HOLD" on the tracked side.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildLabTrack, type ObservationFile } from "@/lib/speaker-tracking/lab-track";
import { readArgs } from "../lab-guard";

const FONT = path.resolve("public/fonts/DejaVuSans-Bold.ttf");
const PANEL_W = 540;
const PANEL_H = 960;

function main() {
  const args = readArgs(process.argv.slice(2));
  const obsPath = args.get("observations");
  const outPath = args.get("out");
  const label = String(args.get("label") ?? "clip");
  const rules = String(args.get("rules") ?? "codex");
  if (typeof obsPath !== "string" || typeof outPath !== "string" || (rules !== "codex" && rules !== "lab-v1")) {
    console.error("Usage: track-clip.ts --observations <json> --out <mp4> [--label text] [--rules codex|lab-v1]");
    process.exit(2);
  }

  const file = JSON.parse(readFileSync(obsPath, "utf8")) as ObservationFile;
  const seekSeconds = file.observations.frames[0].t;
  const track = buildLabTrack(file, { seekSeconds, rules });
  const duration = file.end - seekSeconds;

  const outDir = path.dirname(path.resolve(outPath));
  mkdirSync(outDir, { recursive: true });
  const stem = path.basename(outPath, ".mp4");
  const cmdFile = path.join(outDir, `${stem}.sendcmd.txt`);
  writeFileSync(cmdFile, track.commands + "\n");

  // Only the longer holds are marked; one-frame blips are invisible in playback.
  const visibleHolds = track.holds.filter((h) => h.end - h.start >= 0.3).slice(0, 60);
  const enableHold = visibleHolds.length
    ? visibleHolds.map((h) => `between(t,${h.start.toFixed(3)},${h.end.toFixed(3)})`).join("+")
    : "0";
  const text = (t: string) => t.replace(/[:\\']/g, (c) => `\\${c}`);
  const trackedTitle = rules === "lab-v1" ? "TRACKED (Codex + lab rules)" : "TRACKED (Codex as built)";
  const { w, h } = track.crop;
  const filter = [
    `[0:v]split=2[a][b]`,
    `[a]crop=${w}:${h}:(iw-${w})/2:(ih-${h})/2,scale=${PANEL_W}:${PANEL_H},` +
      `drawtext=fontfile=${FONT}:text='${text(`${label} - TODAY (fixed center)`)}':x=12:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6[l]`,
    `[b]sendcmd=f='${cmdFile}',crop@speaker=w=${w}:h=${h}:x=${track.first.x}:y=${track.first.y},scale=${PANEL_W}:${PANEL_H},` +
      `drawtext=fontfile=${FONT}:text='${text(`${label} - ${trackedTitle}`)}':x=12:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6,` +
      `drawtext=fontfile=${FONT}:text='HOLD - tracker gave up here':x=12:y=${PANEL_H - 52}:fontsize=26:fontcolor=white:box=1:boxcolor=red@0.75:enable='${enableHold}'[r]`,
    `[l][r]hstack=inputs=2[v]`,
  ].join(";");

  execFileSync(
    "ffmpeg",
    [
      "-nostdin", "-y", "-v", "error",
      "-ss", seekSeconds.toFixed(6), "-i", file.source, "-t", duration.toFixed(3),
      "-filter_complex", filter, "-map", "[v]", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
      path.resolve(outPath),
    ],
    { stdio: "inherit" },
  );

  const summary = {
    label,
    rules,
    seconds: Number(duration.toFixed(2)),
    computeSeconds: file.computeSeconds,
    frames: file.observations.frames.length,
    framesWithFaces: file.observations.frames.filter((f) => f.faces.length).length,
    trackedPercent: track.followingPercent,
    shots: track.shots,
    heldIntervals: track.holds,
    labRules: { addedCuts: track.addedCuts, filledFrames: track.filledFrames },
    output: path.resolve(outPath),
  };
  writeFileSync(path.join(outDir, `${stem}.summary.json`), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary));
}

main();
