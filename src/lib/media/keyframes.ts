import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ffprobePath } from "@/lib/env";
import { sha256Schema } from "@/lib/media-artifacts/types";
import { fileIdentity } from "@/lib/storage/file-identity";
import { execFileWithTimeout } from "./child-process";

import { exactTimeMs, compareTimeMs, type ExactTimeMs } from "./exact-time";

const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const inputSchema = z.object({ path: z.string().min(1), sha256: sha256Schema,
  byteCount: integer.positive(), sourceDurationMs: integer.positive(), sourceOriginMs: integer }).strict();
export const keyframeSettingsSchema = z.object({ timeoutMs: integer.positive().max(2147483647),
  maxOutputBytes: integer.positive().max(2147483647), maxPackets: integer.positive() }).strict();
export type KeyframeInput = z.infer<typeof inputSchema>;
export type KeyframeSettings = z.infer<typeof keyframeSettingsSchema>;
const probeSchema = z.object({
  streams: z.array(z.object({ index: integer.nonnegative(), width: integer.positive(), height: integer.positive(),
    time_base: z.string().regex(/^[1-9]\d*\/[1-9]\d*$/), codec_name: z.string().min(1) })).length(1),
  packets: z.array(z.object({ pts: integer.optional(), flags: z.string() })).min(1),
});

/** Packet keyframe flags are seek hints. They do not prove closed GOPs or safe standalone stream copying. */
export async function discoverSourceKeyframes(inputValue: KeyframeInput, settingsValue: KeyframeSettings) {
  const input = inputSchema.parse(inputValue), settings = keyframeSettingsSchema.parse(settingsValue);
  if (!path.isAbsolute(input.path) || !(await lstat(input.path)).isFile()) throw new Error("KEYFRAME_LOCAL_FILE_REQUIRED");
  const before = await fileIdentity(input.path);
  if (before.sha256 !== input.sha256 || before.byteCount !== input.byteCount) throw new Error("KEYFRAME_INPUT_CHANGED");
  const run = (args: string[]) => execFileWithTimeout(ffprobePath(), args,
    { timeoutMs: settings.timeoutMs, maxBuffer: settings.maxOutputBytes });
  const { stdout: version } = await run(["-version"]);
  const { stdout } = await run(["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
    "-show_streams", "-show_packets", "-show_entries", "stream=index,width,height,time_base,codec_name:packet=pts,flags",
    "-of", "json", input.path]);
  const after = await fileIdentity(input.path);
  if (after.sha256 !== before.sha256 || after.byteCount !== before.byteCount) throw new Error("KEYFRAME_INPUT_CHANGED");
  const probe = probeSchema.parse(JSON.parse(stdout));
  if (probe.packets.length > settings.maxPackets) throw new Error("KEYFRAME_PACKET_LIMIT_EXCEEDED");
  const stream = probe.streams[0];
  const [numerator, denominator] = stream.time_base.split("/").map(BigInt);
  const keyframeTimesMs: ExactTimeMs[] = [];
  for (const packet of probe.packets) {
    if (!packet.flags.includes("K")) continue;
    if (packet.flags.includes("D") || packet.flags.includes("C") || packet.pts === undefined) {
      throw new Error("KEYFRAME_PACKET_UNUSABLE");
    }
    const scaled = BigInt(packet.pts) * numerator * BigInt(1000);
    const sourceNumerator = scaled - BigInt(input.sourceOriginMs) * denominator;
    if (sourceNumerator < BigInt(0) || sourceNumerator >= BigInt(input.sourceDurationMs) * denominator) {
      throw new Error("KEYFRAME_OUTSIDE_SOURCE");
    }
    keyframeTimesMs.push(exactTimeMs(sourceNumerator, denominator));
  }
  keyframeTimesMs.sort(compareTimeMs);
  if (!keyframeTimesMs.length) throw new Error("KEYFRAME_NOT_FOUND");
  if (keyframeTimesMs.some((value, index) => index > 0 && compareTimeMs(value, keyframeTimesMs[index - 1]) === 0)) {
    throw new Error("KEYFRAME_DUPLICATE_TIMESTAMP");
  }
  const toolchainSha256 = createHash("sha256").update(version).digest("hex");
  const evidence = { version: "source-packet-keyframes-v2", sourceSha256: input.sha256, sourceByteCount: input.byteCount,
    sourceOriginMs: input.sourceOriginMs, sourceDurationMs: input.sourceDurationMs, stream,
    packetCount: probe.packets.length, keyframeTimesMs, toolchainSha256 };
  return { ...evidence, evidenceSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
}
