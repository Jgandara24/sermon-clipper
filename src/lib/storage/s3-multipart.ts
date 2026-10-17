import { randomUUID } from "node:crypto";
import type { MultipartRequestMeasurement, MultipartRequestOperation } from "./multipart-measurement";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  HeadObjectCommand, ListMultipartUploadsCommand, ListPartsCommand, UploadPartCommand, type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  multipartPartBytes, validateMultipartPlan, validateMultipartSession,
  type MultipartPart, type MultipartPlan, type MultipartSession, type MultipartStorage,
} from "./multipart";

/** Control requests only. File bytes travel from the browser to the storage provider. */
export class S3MultipartStorage implements MultipartStorage {
  constructor(private readonly client: S3Client, private readonly bucket: string,
    private readonly recordRequest?: (measurement: MultipartRequestMeasurement) => Promise<void>) {}

  private async request<T>(plan: MultipartPlan, operation: MultipartRequestOperation, work: () => Promise<T>): Promise<T> {
    if (!this.recordRequest) return work();
    const started = performance.now();
    const requestId = randomUUID();
    let outcome: "succeeded" | "failed" = "failed";
    let httpStatus: number | null = null;
    try {
      const result = await work();
      outcome = "succeeded";
      const status = (result as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (Number.isInteger(status)) httpStatus = status!;
      return result;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
      if (Number.isInteger(status)) httpStatus = status!;
      throw error;
    } finally {
      try {
        await this.recordRequest({ sessionId: plan.sessionId, storageKey: plan.key, requestId, operation,
          wallTimeMs: Math.max(0, performance.now() - started), outcome, httpStatus });
      } catch {
        console.error("[cost] Multipart request measurement could not be recorded.");
      }
    }
  }

  async inspectCompleted(plan: MultipartPlan) {
    validateMultipartPlan(plan);
    let object;
    try {
      object = await this.request(plan, "HeadObject", () => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: plan.key })));
    } catch (error) {
      if (error instanceof Error && ["NotFound", "NoSuchKey"].includes(error.name)) return null;
      throw error;
    }
    if (!object.ETag || object.ContentLength !== plan.totalBytes ||
        object.Metadata?.["upload-session"] !== plan.sessionId ||
        object.Metadata?.["upload-byte-count"] !== String(plan.totalBytes)) {
      throw new Error("MULTIPART_COMPLETED_OBJECT_MISMATCH");
    }
    return { etag: object.ETag, byteCount: plan.totalBytes };
  }

  async findInitiated(plan: MultipartPlan) {
    validateMultipartPlan(plan);
    if (await this.inspectCompleted(plan)) throw new Error("MULTIPART_INITIATION_OBJECT_PRESENT");
    const result = await this.request(plan, "ListMultipartUploads", () => this.client.send(new ListMultipartUploadsCommand({
      Bucket: this.bucket, Prefix: plan.key, MaxUploads: 1000,
    })));
    // The application creates one upload at an exclusive UUID key. An incomplete list cannot prove uniqueness.
    if (result.IsTruncated) throw new Error("MULTIPART_INITIATION_AMBIGUOUS");
    const matches = (result.Uploads ?? []).filter(upload => upload.Key === plan.key);
    if (matches.length > 1) throw new Error("MULTIPART_INITIATION_AMBIGUOUS");
    if (!matches.length) return null;
    const uploadId = matches[0].UploadId;
    if (!uploadId || uploadId.length > 2048) throw new Error("MULTIPART_INITIATION_AMBIGUOUS");
    return { uploadId };
  }

  async create(plan: MultipartPlan) {
    validateMultipartPlan(plan);
    const result = await this.request(plan, "CreateMultipartUpload", () => this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.bucket, Key: plan.key, ContentType: "application/octet-stream",
      Metadata: { "upload-session": plan.sessionId, "upload-byte-count": String(plan.totalBytes) },
    })));
    // An uncertain create must be reconciled by the session owner, never automatically retried here.
    if (!result.UploadId) throw new Error("MULTIPART_CREATE_UNCERTAIN");
    return { uploadId: result.UploadId };
  }

  async signPart(session: MultipartSession, partNumber: number, expiresInSeconds: number) {
    validateMultipartSession(session);
    const byteCount = multipartPartBytes(session, partNumber);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3600) {
      throw new Error("MULTIPART_INVALID_URL_EXPIRY");
    }
    return getSignedUrl(this.client, new UploadPartCommand({
      Bucket: this.bucket, Key: session.key, UploadId: session.uploadId,
      PartNumber: partNumber, ContentLength: byteCount,
    }), { expiresIn: expiresInSeconds, signableHeaders: new Set(["content-length"]) });
  }

  async listParts(session: MultipartSession): Promise<MultipartPart[]> {
    validateMultipartSession(session);
    const count = validateMultipartPlan(session);
    const parts: MultipartPart[] = [];
    let marker: string | undefined;
    let previous = 0;
    // Every page must advance. Bound even malformed provider pagination by the planned part count.
    for (let page = 0; page < count; page++) {
      const result = await this.request(session, "ListParts", () => this.client.send(new ListPartsCommand({
        Bucket: this.bucket, Key: session.key, UploadId: session.uploadId,
        PartNumberMarker: marker, MaxParts: 1000,
      })));
      for (const part of result.Parts ?? []) {
        if (!Number.isInteger(part.PartNumber) || part.PartNumber! <= previous || !part.ETag ||
            part.Size !== multipartPartBytes(session, part.PartNumber!)) {
          throw new Error("MULTIPART_REMOTE_PART_MISMATCH");
        }
        previous = part.PartNumber!;
        parts.push({ partNumber: previous, byteCount: part.Size, etag: part.ETag });
      }
      if (!result.IsTruncated) return parts;
      const next = result.NextPartNumberMarker;
      if (!next || !/^[1-9][0-9]*$/.test(next) || Number(next) !== previous ||
          Number(next) <= Number(marker ?? 0)) throw new Error("MULTIPART_INVALID_PAGINATION");
      marker = next;
    }
    throw new Error("MULTIPART_INVALID_PAGINATION");
  }

  async complete(session: MultipartSession) {
    const parts = await this.listParts(session);
    const count = validateMultipartPlan(session);
    if (parts.length !== count || parts.some((part, index) => part.partNumber !== index + 1)) {
      throw new Error("MULTIPART_INCOMPLETE");
    }
    // ETags come from authenticated storage inspection, never from a browser's claimed completion list.
    const result = await this.request(session, "CompleteMultipartUpload", () => this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket, Key: session.key, UploadId: session.uploadId,
      MultipartUpload: { Parts: parts.map(part => ({ PartNumber: part.partNumber, ETag: part.etag })) },
    })));
    if (!result.ETag) throw new Error("MULTIPART_COMPLETION_UNCERTAIN");
    const object = await this.request(session, "HeadObject", () => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: session.key })));
    if (object.ETag !== result.ETag || object.ContentLength !== session.totalBytes ||
        object.Metadata?.["upload-session"] !== session.sessionId ||
        object.Metadata?.["upload-byte-count"] !== String(session.totalBytes)) {
      throw new Error("MULTIPART_COMPLETION_UNCERTAIN");
    }
    return { etag: result.ETag, byteCount: session.totalBytes };
  }

  async inspectAborted(session: MultipartSession): Promise<boolean> {
    validateMultipartSession(session);
    try {
      await this.request(session, "ListParts", () => this.client.send(new ListPartsCommand({
        Bucket: this.bucket, Key: session.key, UploadId: session.uploadId, MaxParts: 1,
      })));
      // An empty live upload is not proof that cancellation succeeded.
      return false;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "NoSuchUpload") throw error;
    }
    try {
      await this.request(session, "HeadObject", () => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: session.key })));
      return false;
    } catch (error) {
      if (error instanceof Error && ["NotFound", "NoSuchKey"].includes(error.name)) return true;
      throw error;
    }
  }

  async abort(session: MultipartSession) {
    validateMultipartSession(session);
    try {
      await this.request(session, "AbortMultipartUpload", () => this.client.send(new AbortMultipartUploadCommand({
        Bucket: this.bucket, Key: session.key, UploadId: session.uploadId,
      })));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "NoSuchUpload") throw error;
    }
    // Abort can race an in-flight part. Require provider evidence before reporting removal.
    try {
      const remaining = await this.request(session, "ListParts", () => this.client.send(new ListPartsCommand({
        Bucket: this.bucket, Key: session.key, UploadId: session.uploadId, MaxParts: 1,
      })));
      if (remaining.IsTruncated || (remaining.Parts?.length ?? 0) > 0) throw new Error("MULTIPART_ABORT_UNCONFIRMED");
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "NoSuchUpload") throw error;
    }
    // NoSuchUpload can also mean that completion won elsewhere. Keep any completed object for reconciliation.
    try {
      await this.request(session, "HeadObject", () => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: session.key })));
    } catch (error) {
      if (error instanceof Error && ["NotFound", "NoSuchKey"].includes(error.name)) return;
      throw error;
    }
    throw new Error("MULTIPART_ABORT_OBJECT_PRESENT");
  }
}
