import { MULTIPART_MAX_PART_BYTES, MULTIPART_MIN_PART_BYTES } from "@/lib/storage/multipart";

/** Explicit rollout settings; these are not measured production recommendations. */
export function multipartUploadSettings(): { partBytes: number; lifetimeSeconds: number } | null {
  if (process.env.P4_DIRECT_MULTIPART_UPLOAD_ENABLED !== "true") return null;
  const partBytes = Number(process.env.P4_MULTIPART_PART_BYTES);
  const lifetimeSeconds = Number(process.env.P4_MULTIPART_LIFETIME_SECONDS);
  if (!Number.isSafeInteger(partBytes) || partBytes < MULTIPART_MIN_PART_BYTES || partBytes > MULTIPART_MAX_PART_BYTES ||
      !Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 86400) {
    throw new Error("MULTIPART_CONFIGURATION_INVALID");
  }
  return { partBytes, lifetimeSeconds };
}
