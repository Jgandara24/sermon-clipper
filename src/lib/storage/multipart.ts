/** R2-compatible limits. Part size is explicit; callers choose it from measured upload requirements. */
export const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
export const MULTIPART_MAX_PART_BYTES = 5 * 1024 ** 3 - MULTIPART_MIN_PART_BYTES;
export const MULTIPART_MAX_PARTS = 10_000;
export const MULTIPART_MAX_BYTES = 5 * 1024 ** 4;

export type MultipartPlan = {
  key: string;
  sessionId: string;
  totalBytes: number;
  partBytes: number;
};
export type MultipartSession = MultipartPlan & { uploadId: string };
export type MultipartPart = { partNumber: number; byteCount: number; etag: string };

/** Trusted server adapter. HTTP callers must authorize a durable session before invoking any method. */
export interface MultipartStorage {
  /** Read-only proof of a completed object owned by this plan. Null means the object is absent. */
  inspectCompleted(plan: MultipartPlan): Promise<{ etag: string; byteCount: number } | null>;
  /** Finds one unfinished upload at the exclusive key. Ambiguous or truncated evidence must fail. */
  findInitiated(plan: MultipartPlan): Promise<{ uploadId: string } | null>;
  /** True only when the exact provider upload and completed object are both absent. */
  inspectAborted(session: MultipartSession): Promise<boolean>;
  create(plan: MultipartPlan): Promise<{ uploadId: string }>;
  signPart(session: MultipartSession, partNumber: number, expiresInSeconds: number): Promise<string>;
  listParts(session: MultipartSession): Promise<MultipartPart[]>;
  complete(session: MultipartSession): Promise<{ etag: string; byteCount: number }>;
  /** Removes unfinished parts only. It does not remove an object from a completed upload. */
  abort(session: MultipartSession): Promise<void>;
}

export function validateMultipartPlan(plan: MultipartPlan): number {
  if (!plan.key || Buffer.byteLength(plan.key) > 1024 || plan.key.includes("\0") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(plan.sessionId) ||
      !Number.isSafeInteger(plan.totalBytes) || plan.totalBytes <= 0 || plan.totalBytes > MULTIPART_MAX_BYTES ||
      !Number.isSafeInteger(plan.partBytes) || plan.partBytes < MULTIPART_MIN_PART_BYTES ||
      plan.partBytes > MULTIPART_MAX_PART_BYTES) throw new Error("MULTIPART_INVALID_PLAN");
  const count = Math.ceil(plan.totalBytes / plan.partBytes);
  if (count > MULTIPART_MAX_PARTS) throw new Error("MULTIPART_TOO_MANY_PARTS");
  return count;
}

export function multipartPartBytes(plan: MultipartPlan, partNumber: number): number {
  const count = validateMultipartPlan(plan);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) {
    throw new Error("MULTIPART_INVALID_PART_NUMBER");
  }
  return Math.min(plan.partBytes, plan.totalBytes - (partNumber - 1) * plan.partBytes);
}

export function validateMultipartSession(session: MultipartSession) {
  validateMultipartPlan(session);
  if (!session.uploadId || session.uploadId.length > 2048) throw new Error("MULTIPART_INVALID_UPLOAD_ID");
}
